const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function eventSlot() {
    return {
        listener: null,
        addListener(listener) {
            this.listener = listener;
        }
    };
}

function loadBackground(overrides = {}) {
    const events = {
        newMail: eventSlot(),
        updated: eventSlot(),
        moved: eventSlot(),
        alarm: eventSlot(),
        message: eventSlot(),
        installed: eventSlot(),
        startup: eventSlot()
    };

    const browser = {
        storage: {
            local: {
                async get() { return {}; },
                async set() {},
                async remove() {}
            }
        },
        permissions: { async contains() { return true; } },
        accounts: {
            async list() { return []; },
            async get() { return { type: "pop3", identities: [{ email: "person@example.com" }] }; }
        },
        folders: {},
        messages: {
            onNewMailReceived: events.newMail,
            onUpdated: events.updated,
            onMoved: events.moved,
            async list() { return { messages: [] }; },
            async continueList() { return { messages: [] }; },
            async get(messageId) { return { id: messageId }; },
            async update() {}
        },
        alarms: {
            onAlarm: events.alarm,
            async create() {},
            async clear() {}
        },
        runtime: {
            onMessage: events.message,
            onInstalled: events.installed,
            onStartup: events.startup,
            async sendMessage() {},
            async openOptionsPage() {}
        },
        downloads: { async download() {} },
        windows: { async openDefaultBrowser() {} }
    };

    Object.assign(browser, overrides);
    const context = vm.createContext({
        browser,
        console,
        crypto: require("node:crypto").webcrypto,
        TextEncoder,
        URLSearchParams,
        Blob,
        URL,
        AbortController,
        fetch: async () => { throw new Error("unexpected fetch"); },
        btoa: (value) => Buffer.from(value, "binary").toString("base64"),
        setTimeout,
        clearTimeout
    });
    for (const file of ["settings.js", "dropbox-client.js", "background.js"]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context, { filename: file });
    }
    return { context, browser, events };
}

function run(context, expression) {
    return vm.runInContext(expression, context);
}

test("fresh installs are opt-in and optional data features default to off", () => {
    const { context } = loadBackground();
    const defaults = run(context, "normalizeOptions({})");
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.dataConsentVersion, 0);
    assert.equal(defaults.localMirrorEnabled, false);
    assert.equal(defaults.cleanupEmptyFolders, false);
    assert.equal(run(context, "isSyncConfigured(normalizeOptions({}))"), false);
});

for (const [name, patch] of [
    ["missing consent", { dataConsentVersion: 0 }],
    ["no accounts", { selectedAccountEmails: [] }],
    ["disabled sync", { enabled: false }]
]) {
    test(`${name} prevents events, watch, startup scanning, and uploads`, async (t) => {
        const { context, store, events, message, destination, browser } = syncFixture(t);
        Object.assign(store.options, patch);
        let reads = 0;
        browser.messages.list = async () => { reads++; return { messages: [] }; };
        await events.moved.listener({ messages: [] }, { messages: [{ ...message, folder: destination }] });
        await run(context, "pollDropboxChangesAndApply()");
        await run(context, "onStartupHandler()");
        const result = await events.message.listener({ type: "UPLOAD_NOW" });
        assert.equal(result.ok, false);
        assert.equal(store.localState.messages.id.folderPath, "/Inbox");
        assert.equal(reads, 0);
    });
}

test("unselected and IMAP accounts do not contribute local changes", async (t) => {
    const { context, store, message, browser } = syncFixture(t);
    await run(context, `updateLocalFromMessage(${JSON.stringify(message)}, { accountEmail: "other@example.com", read: true })`);
    browser.accounts.get = async () => ({ type: "imap", identities: [{ email: "person@example.com" }] });
    await run(context, `updateLocalFromMessage(${JSON.stringify({ ...message, read: true })})`);
    assert.equal(store.localState.messages.id.read, false);
});

test("upload excludes deselected local data and preserves existing data from other PCs", async (t) => {
    const { context, store } = syncFixture(t);
    store.localState.messages.private = { ...store.localState.messages.id, accountEmail: "private@example.com" };
    context.testCloud.messages.remote = { ...store.localState.messages.id, accountEmail: "remote@example.com" };
    const uploads = [];
    context.uploadDropboxState = async (token, state) => { uploads.push(structuredClone(state)); return { ok: true, rev: "new" }; };
    await run(context, "uploadNowWithConflictResolution()");
    assert.equal(uploads[0].messages.private, undefined);
    assert.equal(uploads[0].messages.remote.accountEmail, "remote@example.com");
});

test("revoking consent removes all local authorization and stops alarms", async (t) => {
    const { events, browser, store } = syncFixture(t);
    store.dropboxCredentials = { accessToken: "secret", refreshToken: "refresh" };
    store.dropboxPkce = { verifier: "verifier" };
    const cleared = [];
    browser.alarms.clear = async name => { cleared.push(name); };
    const result = await events.message.listener({ type: "SAVE_SETTINGS", options: { enabled: false }, appKey: "" });
    assert.equal(result.ok, true);
    assert.equal(store.dropboxToken, undefined);
    assert.equal(store.dropboxCredentials, undefined);
    assert.equal(store.dropboxPkce, undefined);
    assert.equal(store.dropboxWatch, undefined);
    assert.ok(cleared.includes("watchDropboxChanges"));
    assert.ok(cleared.includes("retryDropboxUpload"));
});

test("optional folder deletion requires both opt-in and permission", async (t) => {
    const { context, browser, store } = syncFixture(t);
    let deletions = 0;
    browser.folders.delete = async () => { deletions++; };
    const expression = `deleteFoldersEmptyOnBothSides({ folderStates: {} }, new Set(["person@example.com"]), new Map([["person@example.com", "account-1"]]), [])`;
    assert.equal((await run(context, expression)).deleted, 0);
    store.options.cleanupEmptyFolders = true;
    browser.permissions.contains = async () => false;
    assert.equal((await run(context, expression)).deleted, 0);
    assert.equal(deletions, 0);
});

test("expired Dropbox credentials refresh once and keep secrets out of results", async (t) => {
    const { context, store } = syncFixture(t);
    store.dropboxCredentials = { appKey: "app-key", accessToken: "expired", refreshToken: "private-refresh", expiresAt: 1 };
    const requests = [];
    context.fetch = async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ access_token: "fresh", expires_in: 14400 }) };
    };
    const tokens = await run(context, "Promise.all([getDropboxToken(), getDropboxToken()])");
    assert.deepEqual(Array.from(tokens), ["fresh", "fresh"]);
    assert.equal(requests.length, 1);
    assert.equal(new URLSearchParams(requests[0].options.body).get("grant_type"), "refresh_token");
    assert.equal(requests[0].options.credentials, "omit");
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(store.dropboxCredentials.refreshToken, "private-refresh");
    assert.equal(await run(context, "getDropboxToken()"), "fresh");
});

test("Dropbox authorization uses PKCE and only necessary offline scopes", async (t) => {
    const { context, store, browser } = syncFixture(t);
    store.dropboxConfig = { appKey: "app-key" };
    let url;
    browser.windows.openDefaultBrowser = async value => { url = new URL(value); };
    await run(context, "openDropboxAuthPage()");
    assert.equal(url.searchParams.get("token_access_type"), "offline");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.deepEqual(url.searchParams.get("scope").split(" "), ["files.metadata.read", "files.content.read", "files.content.write"]);
    const challenge = require("node:crypto").createHash("sha256").update(store.dropboxPkce.verifier).digest("base64url");
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    context.fetch = async () => ({ ok: true, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 14400 }) });
    assert.equal((await run(context, 'exchangeCodeForToken("authorization-code")')).ok, true);
    assert.equal(store.dropboxPkce, undefined);
    assert.equal(store.dropboxToken, undefined);
    assert.equal(store.dropboxCredentials.refreshToken, "new-refresh");
});

test("disconnect cannot be undone by a token refresh already in flight", async (t) => {
    const { context, store } = syncFixture(t);
    store.dropboxCredentials = { appKey: "key", accessToken: "expired", refreshToken: "refresh", expiresAt: 1 };
    let release;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    context.fetch = async () => { signalStarted(); return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ access_token: "fresh" }) }); }); };
    const pending = run(context, "getDropboxToken()");
    await started;
    await run(context, "disconnectDropbox()");
    release();
    await assert.rejects(pending, /disconnected/);
    assert.equal(store.dropboxCredentials, undefined);
});

test("malformed cloud data and unexpected Dropbox errors never become an empty overwrite", async (t) => {
    const { context, realIO } = syncFixture(t);
    context.dropboxContentFetch = async () => ({ ok: true, headers: new Headers(), text: async () => "not-json" });
    await assert.rejects(realIO.loadDropboxState("token"), /invalid/);
    context.dropboxContentFetch = async () => ({ ok: false, status: 409, json: async () => ({ error_summary: "path/restricted_content/" }) });
    await assert.rejects(realIO.loadDropboxState("token"), /download failed/);
    context.dropboxContentFetch = async () => ({ ok: false, status: 409, json: async () => ({ error_summary: "path/not_found/" }) });
    assert.equal((await realIO.loadDropboxState("token")).rev, null);
});

test("initial upload uses conflict-safe creation and reads the returned revision", async (t) => {
    const { context, realIO } = syncFixture(t);
    let args;
    context.ensureDropboxBackupDirectory = async () => {};
    context.dropboxContentFetch = async (route, value) => { args = value; return { ok: true, json: async () => ({ rev: "created-rev" }) }; };
    const result = await realIO.uploadDropboxState("token", { messages: {} }, null);
    assert.equal(args.mode[".tag"], "add");
    assert.equal(result.rev, "created-rev");
});

test("progress messages are not claimed by the background reply listener", () => {
    const { events } = loadBackground();
    assert.equal(events.message.listener({ type: "PROGRESS_APPLY" }), undefined);
});

function syncFixture(t) {
    const fixture = loadBackground();
    const { context, browser } = fixture;
    run(context, "DEBUG.enabled = false");
    const email = "person@example.com";
    const inbox = { id: "inbox", accountId: "account-1", name: "受信トレイ", path: "/Inbox", subFolders: [] };
    const destination = { id: "project", accountId: "account-1", name: "案件", path: "/Inbox/project-token", subFolders: [] };
    inbox.subFolders.push(destination);
    const root = { id: "root", accountId: "account-1", name: "POP", path: "/", subFolders: [inbox] };
    const message = { id: 7, headerMessageId: "id", read: false, folder: inbox };
    const record = { accountEmail: email, folderPath: inbox.path, read: false, ts: 100, folderTs: 100 };
    const store = {
        options: { enabled: true, dataConsentVersion: 1, selectedAccountEmails: [email], localMirrorEnabled: false },
        localState: { messages: { id: record } },
        dropboxToken: "test-token",
        dropboxWatch: { cursor: "before", lastStateRev: "old" }
    };
    const moves = [];
    const updates = [];
    browser.storage.local = {
        async get(key) { return structuredClone(Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, store[name]]))); },
        async set(values) { Object.assign(store, structuredClone(values)); },
        async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; }
    };
    browser.accounts = {
        async list() { return [{ id: "account-1", type: "pop3" }]; },
        async get() { return { type: "pop3", identities: [{ email }], rootFolder: structuredClone(root) }; }
    };
    browser.folders.create = async () => { throw new Error("must use existing folder"); };
    browser.messages.list = async (folderId) => ({ messages: folderId === message.folder.id ? [structuredClone(message)] : [] });
    browser.messages.update = async (id, patch) => { updates.push({ id, patch }); Object.assign(message, patch); };
    browser.messages.move = async (ids, folderId) => { moves.push({ ids, folderId }); message.folder = destination; };
    const realIO = { loadDropboxState: run(context, "loadDropboxState"), uploadDropboxState: run(context, "uploadDropboxState") };
    context.testCloud = { messages: { id: { ...record, read: true, ts: 200, folderPath: destination.path, folderTs: 200 } } };
    run(context, `
        loadDropboxState = async () => ({ state: normalizeState(testCloud), rev: "new" });
        dropboxLongpoll = async () => ({ changes: true });
        dropboxListBackupDir = async () => ({ cursor: "after", entries: [{ ".tag": "file", name: "state.json", rev: "new" }] });
    `);
    t.after(() => run(context, "clearTimeout(localFlushTimer); void 0"));
    return { ...fixture, store, root, inbox, destination, message, moves, updates, realIO };
}

test("folder resolution uses API paths, not localized display names", async (t) => {
    const { context } = syncFixture(t);
    const folder = await run(context, 'ensureFolderPath("account-1", "/Inbox/project-token")');
    assert.equal(folder?.id, "project");
});

test("folder hierarchy names can locate a destination with a different local path", async (t) => {
    const { context } = syncFixture(t);
    const folder = await run(context, 'ensureFolderPath("account-1", "/source-token", ["受信トレイ", "案件"])');
    assert.equal(folder?.id, "project");
});

test("watch applies both read state and folder moves through localized folders", async (t) => {
    const { context, message, moves, store } = syncFixture(t);
    await run(context, "pollDropboxChangesAndApply()");
    assert.equal(message.read, true);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].folderId, "project");
    assert.equal(store.dropboxWatch.lastStateRev, "new");
});

test("a failed move preserves the local baseline and watch cursor for retry", async (t) => {
    const { context, browser, message, store, destination } = syncFixture(t);
    let attempts = 0;
    browser.messages.move = async () => {
        if (++attempts === 1) throw new Error("temporary move failure");
        message.folder = destination;
    };
    await assert.rejects(run(context, "pollDropboxChangesAndApply()"));
    assert.equal(message.read, true);
    assert.equal(store.localState.messages.id.folderPath, "/Inbox");
    assert.equal(store.dropboxWatch.cursor, "before");
    await run(context, "pollDropboxChangesAndApply()");
    assert.equal(attempts, 2);
    assert.equal(message.folder.id, "project");
    assert.equal(store.dropboxWatch.cursor, "after");
});

test("manual pull reports move failure and does not commit the unapplied state", async (t) => {
    const { events, browser, store } = syncFixture(t);
    browser.messages.move = async () => { throw new Error("temporary move failure"); };
    const result = await events.message.listener({ type: "PULL_AND_APPLY" });
    assert.equal(result.ok, false);
    assert.match(result.error, /move/i);
    assert.equal(store.localState.messages.id.folderPath, "/Inbox");
});

test("onMoved consumes every MessageList page", async (t) => {
    const { events, browser, store, destination } = syncFixture(t);
    const continuationCalls = [];
    browser.messages.continueList = async (id) => {
        continuationCalls.push(id);
        return { messages: [{ id: 9, headerMessageId: "second", read: false, folder: destination }] };
    };
    await events.moved.listener({ messages: [] }, {
        id: "next-page",
        messages: [{ id: 8, headerMessageId: "id", read: true, folder: destination }]
    });
    assert.deepEqual(continuationCalls, ["next-page"]);
    assert.equal(store.localState.messages.second?.folderPath, destination.path);
    assert.deepEqual(store.localState.messages.id.folderNames, ["受信トレイ", "案件"]);
});

test("startup repairs a previously acknowledged move before a scan can reverse it", async (t) => {
    const { context, store, message, destination } = syncFixture(t);
    store.localState.messages.id = structuredClone(context.testCloud.messages.id);
    run(context, 'uploadDropboxState = async () => ({ ok: true, rev: "uploaded" })');
    await run(context, "onStartupHandler()");
    assert.equal(message.folder.id, destination.id);
    assert.equal(store.localState.messages.id.folderPath, destination.path);
    assert.equal(store.localState.messages.id.folderTs, 200);
});

test("startup gives a cloud move precedence over an untracked local location", async (t) => {
    const { context, store, message, destination } = syncFixture(t);
    store.localState.messages = {};
    run(context, 'uploadDropboxState = async () => ({ ok: true, rev: "uploaded" })');
    await run(context, "onStartupHandler()");
    assert.equal(message.folder.id, destination.id);
    assert.equal(store.localState.messages.id.folderTs, 200);
});

test("failed full reconciliation retries even if Dropbox has no new revision", async (t) => {
    const { context, events, browser, store, message, destination } = syncFixture(t);
    store.localState.messages.id = structuredClone(context.testCloud.messages.id);
    const move = browser.messages.move;
    browser.messages.move = async () => { throw new Error("temporarily locked"); };
    assert.equal((await events.message.listener({ type: "PULL_AND_APPLY" })).ok, false);
    run(context, 'dropboxLongpoll = async () => ({ changes: false })');
    browser.messages.move = move;
    await run(context, "pollDropboxChangesAndApply()");
    assert.equal(message.folder.id, destination.id);
    assert.equal(store.syncMeta.applyPending, false);
});

test("upload conflict resolution does not acknowledge a failed local move", async (t) => {
    const { context, browser, store } = syncFixture(t);
    run(context, 'uploadDropboxState = async () => ({ ok: true, rev: "uploaded" })');
    browser.messages.move = async () => { throw new Error("temporarily locked"); };
    await assert.rejects(run(context, "uploadNowWithConflictResolution()"), /move/);
    assert.equal(store.localState.messages.id.folderPath, "/Inbox");
    assert.equal(store.dropboxWatch.lastStateRev, "old");
});

test("folder names survive merge and upload finalization with the winning move", (t) => {
    const { context } = syncFixture(t);
    const result = run(context, `finalizeStateForSync(mergeByTs(
        { messages: { id: { read: true, ts: 300, folderTs: 100, folderPath: "/old", folderNames: ["Old"] } } },
        { messages: { id: { read: false, ts: 100, folderTs: 200, folderPath: "/token", folderNames: ["案件"] } } }
    ))`);
    assert.equal(result.messages.id.read, true);
    assert.deepEqual(Array.from(result.messages.id.folderNames), ["案件"]);
});

test("creating a nested destination reuses its localized parent", async (t) => {
    const { context, browser } = syncFixture(t);
    const created = [];
    browser.folders.create = async (parent, name) => {
        created.push({ parent, name });
        return { id: "new", name, path: "/Inbox/new-token", subFolders: [] };
    };
    await run(context, 'ensureFolderPath("account-1", "/Inbox/foreign-token", ["Inbox", "新しい案件"])');
    assert.deepEqual(created, [{ parent: "inbox", name: "新しい案件" }]);
});

for (const baseline of ["legacy", "untracked"]) {
    test(`a read event on a ${baseline} message cannot undo a cloud move`, async (t) => {
        const { context, events, store, message, destination } = syncFixture(t);
        if (baseline === "legacy") delete store.localState.messages.id.folderTs;
        else delete store.localState.messages.id;
        await events.updated.listener(structuredClone(message), { read: true });
        // Merge and publish as the automatic flush does, then apply the move.
        const uploads = [];
        context.uploadDropboxState = async (_token, state) => {
            uploads.push(structuredClone(state));
            return { ok: true, rev: "uploaded" };
        };
        await run(context, "uploadNowWithConflictResolution()");
        assert.equal(uploads[0].messages.id.folderPath, destination.path);
        assert.equal(message.folder.id, destination.id);
        assert.equal(store.localState.messages.id.folderTs, 200);
        assert.equal(store.localState.messages.id.read, true);
    });
}

test("a full scan preserves an unchanged startup location with a zero timestamp", async (t) => {
    const { context, store, message, destination } = syncFixture(t);
    delete store.localState.messages.id;
    await run(context, "fullScanToLocalState({ startup: true })");
    assert.equal(store.localState.messages.id.folderTs, 0);
    await run(context, "fullScanToLocalState()");
    assert.equal(store.localState.messages.id.folderTs, 0);
    await run(context, "pullCloudStateAndApply()");
    assert.equal(message.folder.id, destination.id);
});

test("overlapping read and move events preserve both independent changes", async (t) => {
    const { events, store, message, destination } = syncFixture(t);
    await Promise.all([
        events.updated.listener(structuredClone(message), { read: true }),
        events.moved.listener({ messages: [] }, { messages: [{ ...message, folder: destination }] })
    ]);
    assert.equal(store.localState.messages.id.read, true);
    assert.equal(store.localState.messages.id.folderPath, destination.path);
});

test("events during upload are processed after its snapshot is committed", async (t) => {
    const { context, events, store, message, inbox } = syncFixture(t);
    context.testCloud = { messages: structuredClone(store.localState.messages) };
    let releaseUpload;
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    context.uploadDropboxState = async () => {
        notifyStarted();
        await new Promise(resolve => { releaseUpload = resolve; });
        return { ok: true, rev: "uploaded" };
    };
    const upload = events.message.listener({ type: "UPLOAD_NOW" });
    await started;
    const edit = events.updated.listener({ ...message, folder: inbox }, { read: true });
    await new Promise(resolve => setImmediate(resolve));
    releaseUpload();
    await Promise.all([upload, edit]);
    assert.equal(store.localState.messages.id.read, true);
    assert.equal(store.syncMeta.pending, true);
});

test("an incomplete folder listing does not acknowledge a cloud move", async (t) => {
    const { context, browser, store } = syncFixture(t);
    browser.messages.list = async () => { throw new Error("folder unavailable"); };
    await assert.rejects(run(context, "pollDropboxChangesAndApply()"), /indexing/);
    assert.equal(store.dropboxWatch.cursor, "before");
    assert.equal(store.localState.messages.id.folderPath, "/Inbox");
});

test("a full scan retains move history when only the native path differs", async (t) => {
    const { context, store, message, destination } = syncFixture(t);
    message.folder = destination;
    store.localState.messages.id = {
        ...store.localState.messages.id,
        folderPath: "/foreign-token", folderNames: ["受信トレイ", "案件"], folderTs: 300
    };
    await run(context, "fullScanToLocalState()");
    assert.equal(store.localState.messages.id.folderPath, destination.path);
    assert.equal(store.localState.messages.id.folderTs, 300);
    assert.equal(store.localState.messages.id.folderBaseTs, undefined);
});

test("different display languages for the same API path do not generate moves", (t) => {
    const { context } = syncFixture(t);
    assert.equal(run(context, `sameFolderLocation(
        { folderPath: "/Inbox", folderNames: ["Inbox"] },
        { folderPath: "/Inbox", folderNames: ["受信トレイ"] }
    )`), true);
});

test("events generated by applying a move do not become fresh local edits", async (t) => {
    const { context, browser, events, store, message, destination } = syncFixture(t);
    browser.messages.move = async () => {
        message.folder = destination;
        await events.moved.listener({ messages: [] }, { messages: [message] });
    };
    await run(context, "pollDropboxChangesAndApply()");
    assert.equal(store.localState.messages.id.folderTs, 200);
    assert.equal(store.localState.messages.id.folderBaseTs, undefined);
    assert.notEqual(store.syncMeta?.pending, true);
});

test("Dropbox longpoll does not block recording local moves", async (t) => {
    const { context, events, store, message, destination } = syncFixture(t);
    let releasePoll;
    let notifyStarted;
    const started = new Promise(resolve => { notifyStarted = resolve; });
    context.dropboxLongpoll = async () => {
        notifyStarted();
        return new Promise(resolve => { releasePoll = () => resolve({ changes: false }); });
    };
    const poll = run(context, "pollDropboxChangesAndApply()");
    await started;
    try {
        await events.moved.listener({ messages: [] }, { messages: [{ ...message, folder: destination }] });
        assert.equal(store.localState.messages.id.folderPath, destination.path);
    } finally {
        releasePoll();
        await poll;
    }
});

test("startup adds portable folder names to legacy records without inventing a move", async (t) => {
    const { context, store, message, destination } = syncFixture(t);
    message.folder = destination;
    message.read = true;
    store.localState.messages.id = structuredClone(context.testCloud.messages.id);
    const uploads = [];
    context.uploadDropboxState = async (token, state) => {
        uploads.push(structuredClone(state));
        return { ok: true, rev: "uploaded" };
    };
    await run(context, "onStartupHandler()");
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].messages.id.folderNames, ["受信トレイ", "案件"]);
    assert.equal(uploads[0].messages.id.folderTs, 200);
});

test("manifest requests folder-delete and message-move access", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
    assert.equal(manifest.optional_permissions.includes("messagesDelete"), true);
    assert.equal(manifest.permissions.includes("messagesMove"), true);
});

test("read wins a conflict regardless of record timestamp", () => {
    const { context } = loadBackground();
    const merged = run(context, `mergeByTs(
        {
            accounts: ["person@example.com"], folders: {}, folderStates: {},
            messages: { id: { accountEmail: "person@example.com", folderPath: "/Local", read: false, ts: 200 } }
        },
        {
            accounts: ["person@example.com"], folders: {}, folderStates: {},
            messages: { id: { accountEmail: "person@example.com", folderPath: "/Remote", read: true, ts: 100 } }
        }
    )`);

    assert.equal(merged.messages.id.read, true);
    assert.equal(merged.messages.id.ts, 200);
    assert.equal(merged.messages.id.folderPath, "/Local");
});

test("read and folder conflicts resolve independently", () => {
    const { context } = loadBackground();
    const merged = run(context, `mergeByTs(
        { messages: { id: {
            accountEmail: "person@example.com", folderPath: "/Local", read: true,
            ts: 300, folderTs: 100
        } } },
        { messages: { id: {
            accountEmail: "person@example.com", folderPath: "/Remote", read: false,
            ts: 200, folderTs: 400
        } } }
    )`);

    assert.equal(merged.messages.id.read, true);
    assert.equal(merged.messages.id.folderPath, "/Remote");
});

test("a causally later unread action is synchronized rather than treated as a conflict", () => {
    const { context } = loadBackground();
    const merged = run(context, `mergeByTs(
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: true, ts: 100 } } },
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/B", read: false, ts: 200, parentTs: 100 } } }
    )`);
    assert.equal(merged.messages.id.read, false);

    const delta = run(context, `computeDelta(
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: true, ts: 100 } } },
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/B", read: false, ts: 200, parentTs: 100 } } }
    )`);
    assert.equal(delta.toProcess.length, 1);
});

test("finalization preserves causal ancestry and excludes undisclosed data at every level", () => {
    const { context } = loadBackground();
    const finalized = run(context, `finalizeStateForSync({
        dropboxCredentials: { accessToken: "test-secret" },
        client: { clientId: "client", createdAt: 1, privateNote: "private" },
        folderStates: { "person@example.com": { "/A": { empty: false, messageCount: 1, ts: 190, subject: "private" } } },
        messages: {
            id: {
                accountEmail: "person@example.com", folderPath: "/A", read: false,
                flagged: true, tags: ["x"], ts: 200, baseTs: 100,
                folderTs: 190, folderBaseTs: 90,
                subject: "private", body: "private", attachments: ["private"], author: "private"
            }
        }
    })`);
    assert.equal(finalized.messages.id.parentTs, 100);
    assert.equal(finalized.messages.id.folderParentTs, 90);
    assert.equal("baseTs" in finalized.messages.id, false);
    assert.equal("flagged" in finalized.messages.id, false);
    assert.equal("tags" in finalized.messages.id, false);
    assert.equal("dropboxCredentials" in finalized, false);
    assert.equal("privateNote" in finalized.client, false);
    assert.equal("subject" in finalized.folderStates["person@example.com"]["/A"], false);
    for (const field of ["subject", "body", "attachments", "author"]) assert.equal(field in finalized.messages.id, false);
});

test("delta contains effective read or folder changes only", () => {
    const { context } = loadBackground();
    const readWins = run(context, `computeDelta(
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: true, flagged: false, ts: 1 } } },
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: false, flagged: true, ts: 2 } } }
    )`);
    assert.equal(readWins.toProcess.length, 0);

    const applyRead = run(context, `computeDelta(
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: false, flagged: false, ts: 20 } } },
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/B", read: true, flagged: true, ts: 10 } } }
    )`);
    assert.equal(applyRead.toProcess.length, 1);

    const metadataOnly = run(context, `computeDelta(
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: true, flagged: false, tags: [], ts: 1 } } },
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: true, flagged: true, tags: ["x"], ts: 2 } } }
    )`);
    assert.equal(metadataOnly.toProcess.length, 0);

    const folderMove = run(context, `computeDelta(
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/A", read: true, ts: 1, folderTs: 1 } } },
        { messages: { id: { accountEmail: "person@example.com", folderPath: "/B", read: true, ts: 1, folderTs: 2 } } }
    )`);
    assert.equal(folderMove.toProcess.length, 1);
    assert.equal(folderMove.toProcess[0].applyRead, false);
    assert.equal(folderMove.toProcess[0].applyFolder, true);
});

test("delta apply can update read without moving a message", async () => {
    const root = {
        id: "root",
        path: "/",
        subFolders: [{ id: "folder-a", path: "/A", subFolders: [] }]
    };
    const updates = [];
    const { context } = loadBackground({
        storage: {
            local: {
                async get(key) {
                    if (key === "options") {
                        return { options: { enabled: true, dataConsentVersion: 1, selectedAccountEmails: ["person@example.com"] } };
                    }
                    return {};
                },
                async set() {},
                async remove() {}
            }
        },
        accounts: {
            async list() { return [{ id: "account-1", name: "POP", type: "pop3" }]; },
            async get() { return { type: "pop3", identities: [{ email: "person@example.com" }], rootFolder: root }; }
        },
        messages: {
            onNewMailReceived: eventSlot(),
            onUpdated: eventSlot(),
            onMoved: eventSlot(),
            async list(folderId) {
                return folderId === "folder-a"
                    ? { messages: [{ id: 7, headerMessageId: "id", read: false, flagged: true, folder: { accountId: "account-1", path: "/A" } }] }
                    : { messages: [] };
            },
            async continueList() { return { messages: [] }; },
            async get(messageId) { return { id: messageId }; },
            async update(messageId, patch) { updates.push({ messageId, patch }); },
            async move() { throw new Error("move must not be called"); }
        }
    });

    const result = await run(context, `applyDeltaToThunderbird({
        toProcess: [{
            hid: "id",
            rec: { accountEmail: "person@example.com", folderPath: "/A", read: true, flagged: false, ts: 1 },
            applyRead: true,
            applyFolder: false
        }],
        scanFoldersNeeded: new Map()
    })`);

    assert.equal(result.applied, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ messageId: 7, patch: { read: true } }]);
});

test("delta apply moves a message to the resolved folder", async () => {
    const root = {
        id: "root",
        path: "/",
        subFolders: [{ id: "folder-a", name: "A", path: "/A", subFolders: [] }]
    };
    const moves = [];
    const creations = [];
    const { context } = loadBackground({
        storage: {
            local: {
                async get(key) {
                    if (key === "options") {
                        return { options: { enabled: true, dataConsentVersion: 1, selectedAccountEmails: ["person@example.com"] } };
                    }
                    return {};
                },
                async set() {},
                async remove() {}
            }
        },
        accounts: {
            async list() { return [{ id: "account-1", name: "POP", type: "pop3" }]; },
            async get() { return { type: "pop3", identities: [{ email: "person@example.com" }], rootFolder: root }; }
        },
        folders: {
            async create(parent, name) {
                creations.push({ parent, name });
                return { id: "folder-b", name, path: `/${name}`, subFolders: [] };
            }
        },
        messages: {
            onNewMailReceived: eventSlot(),
            onUpdated: eventSlot(),
            onMoved: eventSlot(),
            async list(folderId) {
                return folderId === "folder-a"
                    ? { messages: [{ id: 9, headerMessageId: "id", read: true, folder: { accountId: "account-1", path: "/A" } }] }
                    : { messages: [] };
            },
            async continueList() { return { messages: [] }; },
            async get(messageId) { return { id: messageId }; },
            async update() {},
            async move(messageIds, destination) { moves.push({ messageIds, destination }); }
        }
    });

    const result = await run(context, `applyDeltaToThunderbird({
        toProcess: [{
            hid: "id",
            rec: { accountEmail: "person@example.com", folderPath: "/B", read: true, ts: 1, folderTs: 2 },
            applyRead: false,
            applyFolder: true
        }],
        scanFoldersNeeded: new Map()
    })`);

    assert.equal(result.moved, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(creations)), [{ parent: "root", name: "B" }]);
    assert.deepEqual(JSON.parse(JSON.stringify(moves)), [{ messageIds: [9], destination: "folder-b" }]);
});

test("onMoved records the new folder without changing read history", async () => {
    const store = {
        options: { enabled: true, dataConsentVersion: 1, selectedAccountEmails: ["person@example.com"] },
        localState: {
            schema: "mailstate-sync/v7",
            client: { clientId: "client", createdAt: 1 },
            accounts: ["person@example.com"],
            folders: { "person@example.com": ["/A"] },
            folderStates: {},
            messages: {
                id: {
                    accountEmail: "person@example.com",
                    folderPath: "/A",
                    read: true,
                    ts: 100,
                    folderTs: 100
                }
            }
        }
    };
    const { context, events } = loadBackground({
        storage: {
            local: {
                async get(key) { return { [key]: store[key] }; },
                async set(values) { Object.assign(store, values); },
                async remove(key) { delete store[key]; }
            }
        },
        accounts: {
            async list() { return []; },
            async get() { return { type: "pop3", identities: [{ email: "person@example.com" }] }; }
        }
    });

    await events.moved.listener(
        { messages: [] },
        {
            messages: [{
                id: 9,
                headerMessageId: "id",
                read: true,
                folder: { accountId: "account-1", path: "/B" }
            }]
        }
    );
    run(context, `if (localFlushTimer) { clearTimeout(localFlushTimer); localFlushTimer = null; }`);

    const record = store.localState.messages.id;
    assert.equal(record.folderPath, "/B");
    assert.equal(record.folderBaseTs, 100);
    assert.equal(record.read, true);
    assert.equal(record.ts, 100);
});

test("empty-folder cleanup requires both sides empty and protects standard folders", async () => {
    const root = {
        id: "root",
        path: "/",
        subFolders: [
            { id: "delete-me", path: "/DeleteMe", subFolders: [] },
            { id: "keep-nonempty", path: "/KeepNonempty", subFolders: [] },
            { id: "list-fails", path: "/ListFails", subFolders: [] },
            { id: "inbox", path: "/Inbox", type: "inbox", subFolders: [] },
            { id: "unknown-source", path: "/UnknownSource", subFolders: [] }
        ]
    };
    const deleted = [];
    const { context } = loadBackground({
        accounts: {
            async list() { return []; },
            async get() { return { type: "pop3", identities: [{ email: "person@example.com" }], rootFolder: root }; }
        },
        folders: {
            async delete(folderId) { deleted.push(folderId); }
        },
        messages: {
            onNewMailReceived: eventSlot(),
            onUpdated: eventSlot(),
            onMoved: eventSlot(),
            async list(folderId) {
                if (folderId === "keep-nonempty") return { messages: [{ id: 1 }] };
                if (folderId === "list-fails") throw new Error("folder unavailable");
                return { messages: [] };
            },
            async continueList() { return { messages: [] }; },
            async get(messageId) { return { id: messageId }; },
            async update() {}
        }
    });

    run(context, `getOptions = async () => normalizeOptions({enabled:true, dataConsentVersion:1, selectedAccountEmails:["person@example.com"], cleanupEmptyFolders:true})`);
    const result = await run(context, `deleteFoldersEmptyOnBothSides(
        {
            folderStates: {
                "person@example.com": {
                    "/DeleteMe": { empty: true, messageCount: 0, ts: 1 },
                    "/KeepNonempty": { empty: true, messageCount: 0, ts: 1 },
                    "/ListFails": { empty: true, messageCount: 0, ts: 1 },
                    "/Inbox": { empty: true, messageCount: 0, ts: 1 }
                }
            }
        },
        new Set(["person@example.com"]),
        new Map([["person@example.com", "account-1"]]),
        []
    )`);

    assert.equal(result.deleted, 1);
    assert.equal(result.skippedNotEmpty, 1);
    assert.equal(result.skippedProtected, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(deleted, ["delete-me"]);
});

test("legacy state does not guess that a folder is empty", () => {
    const { context } = loadBackground();
    const paths = run(context, `sourceEmptyFolderPaths(
        normalizeState({ schema: "mailstate-sync/v5", folders: { "person@example.com": ["/Old"] }, messages: {} }),
        "person@example.com"
    )`);
    assert.deepEqual(Array.from(paths), []);
});
