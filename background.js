/**
 * MailState Sync (Local canonical + Downloads mirror + Dropbox)
 *
 * ✅ Current spec (as of 2026-09-18)
 * - Local canonical: storage.local KEY_LOCAL_STATE
 * - Local JSON mirror file: Downloads/thunderbird_backup/state.local.json (overwrite)
 * - Dropbox: /thunderbird_backup/state.json
 * - A (writer): on local changes -> pending -> debounce flush -> upload; on failure retry every 5min
 * - B (reader): detects Dropbox updates (cursor + longpoll via alarms) and applies only deltas
 * - Sync targets: read/unread state and message folder location
 * - Read conflict: read wins over unread (headerMessageId key)
 * - Folder conflict: causally later move, then newest timestamp wins
 * - Empty folders: delete on the destination only when the source scan and the
 *   live destination both report the folder empty
 * - Cloud pull (manual): resolve read conflicts, then apply
 *
 * ✅ Performance:
 * - Delta apply: only messages whose resolved read state or folder differs
 */

const KEY_OPTIONS = "options";
const KEY_DROPBOX_CFG = "dropboxConfig"; // { appKey }
const TOKEN_KEY = "dropboxToken";
const KEY_PKCE = "dropboxPkce"; // { verifier, createdAt }

const KEY_LOCAL_STATE = "localState"; // canonical state in storage.local
const KEY_SYNC_META = "syncMeta"; // { lastUploadOk, lastUploadAt, lastError, pending, applyPending }

const DROPBOX_BACKUP_DIR = "/thunderbird_backup";
const DROPBOX_STATE_PATH = `${DROPBOX_BACKUP_DIR}/state.json`;
const DEFAULT_LOCAL_MIRROR_FILENAME = "thunderbird_backup/state.local.json"; // relative to Downloads

const LOCAL_FLUSH_DEBOUNCE_MS = 1200;
let localFlushTimer = null;

const RETRY_ALARM = "retryDropboxUpload";
const RETRY_PERIOD_MIN = 5;

const WATCH_ALARM = "watchDropboxChanges";
const WATCH_PERIOD_MIN = 1;

// ✅ apply中イベント抑止フラグ
let IS_APPLYING = false;
let SUPPRESSED_EVENTS = 0;

// storage.local get/set is not an atomic read-modify-write. Serialize event
// writes and sync commits so a read event cannot overwrite a concurrent move.
let syncOperationTail = Promise.resolve();
function enqueueSyncOperation(operation) {
    const result = syncOperationTail.then(operation);
    syncOperationTail = result.catch(() => {});
    return result;
}

function suppressApplyEvent() {
    if (!IS_APPLYING) return false;
    SUPPRESSED_EVENTS++;
    return true;
}

// ========================
// Debug / Logging
// ========================
const DEBUG = {
    enabled: false,
    verbose: false,
    everyN: 25,
    logFirstNMoves: 50,
    logFirstNUpdates: 50,
    logFirstNNotFound: 50,
    logQueryResultsSample: true,
    time: true
};

function nowIso() { return new Date().toISOString(); }
function dlog(...args) {
    if (!DEBUG.enabled) return;
    if (DEBUG.time) console.log(`[MailStateSync ${nowIso()}]`, ...args);
    else console.log("[MailStateSync]", ...args);
}
function dwarn(...args) {
    if (!DEBUG.enabled) return;
    if (DEBUG.time) console.warn(`[MailStateSync ${nowIso()}]`, ...args);
    else console.warn("[MailStateSync]", ...args);
}
function derr(...args) {
    if (!DEBUG.enabled) return;
    if (DEBUG.time) console.error(`[MailStateSync ${nowIso()}]`, ...args);
    else console.error("[MailStateSync]", ...args);
}
function summarizeState(state) {
    try {
        const st = state ?? {};
        const accounts = Array.isArray(st.accounts) ? st.accounts.length : 0;
        const folders = st.folders && typeof st.folders === "object"
            ? Object.values(st.folders).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0)
            : 0;
        const messages = st.messages && typeof st.messages === "object"
            ? Object.keys(st.messages).length
            : 0;
        const fpCount = new Map();
        if (st.messages && typeof st.messages === "object") {
            for (const rec of Object.values(st.messages)) {
                const p = (rec?.folderPath ?? "").toString();
                fpCount.set(p, (fpCount.get(p) ?? 0) + 1);
            }
        }
        const topFolderPaths = Array.from(fpCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        return { schema: st.schema, updatedAt: st.updatedAt, accounts, folders, messages, topFolderPaths };
    } catch (e) {
        return { error: String(e?.message ?? e) };
    }
}

// ---------------- Shared settings ----------------
const { normalizeOptions, sanitizeDownloadRelativePath, isSyncConfigured, isPop3Account } = MailStateSettings;
async function getOptions() {
    const { [KEY_OPTIONS]: options } = await browser.storage.local.get(KEY_OPTIONS);
    return normalizeOptions(options);
}
async function requireSyncOptions() {
    const options = await getOptions();
    if (!isSyncConfigured(options)) throw new Error("Enable sync, select a POP3 account, and accept the data disclosure in settings.");
    return options;
}

function normalizePrefix(p) {
    let s = (p ?? "").toString().trim();
    if (!s) return "";
    if (!s.startsWith("/")) s = "/" + s;
    if (s === "/") return "/";
    if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
    return s;
}
function folderAllowed(folderPath, prefixes) {
    const path = (folderPath ?? "").toString();
    const ps = Array.isArray(prefixes) ? prefixes.map(normalizePrefix).filter(Boolean) : [];
    if (ps.length === 0) return true;
    if (ps.includes("/")) return true;
    return ps.some((pref) => path === pref || path.startsWith(pref + "/"));
}

// ---------------- Dropbox watch (cursor + rev) ----------------
const KEY_DROPBOX_WATCH = "dropboxWatch";
// { cursor: string|null, lastStateRev: string|null, lastCheckedAt: number }
async function loadDropboxWatch() {
    const { [KEY_DROPBOX_WATCH]: w } = await browser.storage.local.get(KEY_DROPBOX_WATCH);
    return w ?? { cursor: null, lastStateRev: null, lastCheckedAt: 0 };
}
async function saveDropboxWatch(patch) {
    const cur = await loadDropboxWatch();
    await browser.storage.local.set({ [KEY_DROPBOX_WATCH]: { ...cur, ...(patch ?? {}) } });
}

async function dropboxListBackupDir(token, cursor = null) {
    if (!cursor) {
        return dropboxApiFetch("files/list_folder", {
            path: DROPBOX_BACKUP_DIR,
            recursive: false,
            include_deleted: false
        }, token);
    }
    return dropboxApiFetch("files/list_folder/continue", { cursor }, token);
}

function findStateJsonEntry(listFolderResult) {
    const entries = listFolderResult?.entries ?? [];
    return entries.find(e => e[".tag"] === "file" && e.path_lower === DROPBOX_STATE_PATH.toLowerCase()) ??
        entries.find(e => e[".tag"] === "file" && e.name === "state.json") ??
        null;
}

async function ensureDropboxCursorInitialized() {
    const token = await getDropboxToken();
    if (!token) return;

    const w = await loadDropboxWatch();
    if (w.cursor) return;

    await ensureDropboxBackupDirectory(token);
    const first = await dropboxListBackupDir(token, null);
    const entry = findStateJsonEntry(first);
    await saveDropboxWatch({
        cursor: first.cursor,
        lastStateRev: entry?.rev ?? null,
        lastCheckedAt: Date.now()
    });

    dlog("Dropbox watch initialized", { hasCursor: true, lastStateRev: entry?.rev ?? null });
}

async function ensureWatchAlarm() {
    const options = await getOptions();
    if (!isSyncConfigured(options) || !options.watchEnabled) {
        await browser.alarms.clear(WATCH_ALARM);
        return;
    }
    await browser.alarms.create(WATCH_ALARM, { periodInMinutes: WATCH_PERIOD_MIN });
}

// ---------------- Schema v7 ----------------
function createClientId() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function emptyState() {
    return {
        schema: "mailstate-sync/v7",
        client: { clientId: createClientId(), createdAt: Date.now() },
        updatedAt: new Date().toISOString(),
        accounts: [],
        folders: {},
        folderStates: {},
        messages: {}
    };
}

function normalizeState(s) {
    const st = (s && typeof s === "object") ? s : emptyState();

    if (!st.schema) st.schema = "mailstate-sync/v7";
    if (!st.client || typeof st.client !== "object") st.client = { clientId: createClientId(), createdAt: Date.now() };
    if (!st.client.clientId) st.client.clientId = createClientId();
    if (!st.client.createdAt) st.client.createdAt = Date.now();

    if (!Array.isArray(st.accounts)) st.accounts = [];
    if (!st.folders || typeof st.folders !== "object") st.folders = {};
    // v5 and older did not record whether a folder was empty. Do not infer
    // emptiness from their message cache: that cache intentionally retains
    // records that may still exist on another client.
    if (!st.folderStates || typeof st.folderStates !== "object") st.folderStates = {};
    if (!st.messages || typeof st.messages !== "object") st.messages = {};

    return st;
}

function makeRecord({ accountEmail, folderPath, read, baseTs }) {
    const ts = typeof baseTs === "number" ? Math.max(Date.now(), baseTs + 1) : Date.now();
    const rec = {
        accountEmail: (accountEmail ?? "").toString().trim().toLowerCase(),
        folderPath: folderPath ?? null,
        read: !!read,
        ts,
        folderTs: ts
    };
    if (typeof baseTs === "number") rec.baseTs = baseTs;
    return rec;
}

function ensureAccountAndFolder(state, accountEmail, folderPath) {
    const email = (accountEmail ?? "").toString().trim().toLowerCase();
    if (!email) return;

    if (!state.accounts.includes(email)) state.accounts.push(email);

    if (!state.folders[email]) state.folders[email] = [];
    if (folderPath && typeof folderPath === "string") {
        if (!state.folders[email].includes(folderPath)) state.folders[email].push(folderPath);
    }
}

function setFolderState(state, accountEmail, folderPath, messageCount, ts = Date.now()) {
    const email = (accountEmail ?? "").toString().trim().toLowerCase();
    const path = (folderPath ?? "").toString();
    if (!email || !path || !Number.isFinite(messageCount) || messageCount < 0) return;

    if (!state.folderStates[email] || typeof state.folderStates[email] !== "object") {
        state.folderStates[email] = {};
    }
    state.folderStates[email][path] = {
        empty: messageCount === 0,
        messageCount,
        ts: typeof ts === "number" ? ts : Date.now()
    };
}

function markFolderNonEmpty(state, accountEmail, folderPath) {
    const email = (accountEmail ?? "").toString().trim().toLowerCase();
    const path = (folderPath ?? "").toString();
    if (!email || !path) return false;

    const previous = state?.folderStates?.[email]?.[path];
    if (previous?.empty === false) return false;
    const count = typeof previous?.messageCount === "number"
        ? Math.max(previous.messageCount, 1)
        : 1;
    setFolderState(state, email, path, count);
    return true;
}

function upsertMessageRecord(state, headerMessageId, rec) {
    if (!headerMessageId) return;
    const prev = state.messages[headerMessageId];
    const tPrev = Math.max(
        typeof prev?.ts === "number" ? prev.ts : 0,
        typeof prev?.folderTs === "number" ? prev.folderTs : 0
    );
    const tNew = Math.max(
        typeof rec?.ts === "number" ? rec.ts : 0,
        typeof rec?.folderTs === "number" ? rec.folderTs : 0
    );
    if (!prev || tNew >= tPrev) state.messages[headerMessageId] = rec;
}

function resolveReadRecord(a, b) {
    const ta = typeof a.ts === "number" ? a.ts : 0;
    const tb = typeof b.ts === "number" ? b.ts : 0;

    // baseTs identifies the synchronized record from which a local change was
    // made. This distinguishes a later intentional unread action from a true
    // concurrent edit on two clients.
    if (!!a.read !== !!b.read) {
        const aFollowsB =
            (typeof a.baseTs === "number" && a.baseTs === tb) ||
            (typeof a.parentTs === "number" && a.parentTs === tb);
        const bFollowsA =
            (typeof b.baseTs === "number" && b.baseTs === ta) ||
            (typeof b.parentTs === "number" && b.parentTs === ta);
        if (aFollowsB && !bFollowsA) return a;
        if (bFollowsA && !aFollowsB) return b;

        // Neither record causally follows the other: this is a conflict, so
        // read wins even if the unread record has the later wall-clock time.
        const readRecord = a.read ? a : b;
        const resolved = { ...readRecord, read: true, ts: Math.max(ta, tb) };
        delete resolved.baseTs;
        delete resolved.parentTs;
        return resolved;
    }

    return tb > ta ? b : a;
}

function folderRecordTs(rec) {
    if (typeof rec?.folderTs === "number") return rec.folderTs;
    return typeof rec?.ts === "number" ? rec.ts : 0;
}

function validFolderNames(names) {
    return Array.isArray(names) && names.length > 0 && names.every(name => typeof name === "string" && name.length > 0);
}

function sameFolderLocation(a, b) {
    if ((a?.folderPath ?? null) === (b?.folderPath ?? null)) return true;
    if (validFolderNames(a?.folderNames) && validFolderNames(b?.folderNames)) {
        return JSON.stringify(a.folderNames) === JSON.stringify(b.folderNames);
    }
    return (a?.folderPath ?? null) === (b?.folderPath ?? null);
}

function resolveFolderRecord(a, b) {
    const ta = folderRecordTs(a);
    const tb = folderRecordTs(b);
    const pathA = a?.folderPath ?? null;
    const pathB = b?.folderPath ?? null;
    if (sameFolderLocation(a, b)) return tb > ta ? b : a;

    const aFollowsB =
        (typeof a?.folderBaseTs === "number" && a.folderBaseTs === tb) ||
        (typeof a?.folderParentTs === "number" && a.folderParentTs === tb);
    const bFollowsA =
        (typeof b?.folderBaseTs === "number" && b.folderBaseTs === ta) ||
        (typeof b?.folderParentTs === "number" && b.folderParentTs === ta);
    if (aFollowsB && !bFollowsA) return a;
    if (bFollowsA && !aFollowsB) return b;
    if (ta !== tb) return tb > ta ? b : a;

    // Deterministic tie-breaker prevents clients from choosing opposite paths.
    return String(pathB).localeCompare(String(pathA)) > 0 ? b : a;
}

function mergeMessageRecords(a, b) {
    if (!a) return b;
    if (!b) return a;

    const readRecord = resolveReadRecord(a, b);
    const folderRecord = resolveFolderRecord(a, b);
    const merged = {
        accountEmail: (readRecord?.accountEmail ?? folderRecord?.accountEmail ?? "").toString().trim().toLowerCase(),
        folderPath: folderRecord?.folderPath ?? null,
        read: !!readRecord?.read,
        ts: typeof readRecord?.ts === "number" ? readRecord.ts : 0,
        folderTs: folderRecordTs(folderRecord)
    };

    const namesRecord = validFolderNames(folderRecord?.folderNames) ? folderRecord
        : (sameFolderLocation(a, b) ? (validFolderNames(a?.folderNames) ? a : b) : null);
    if (validFolderNames(namesRecord?.folderNames)) merged.folderNames = [...namesRecord.folderNames];

    if (typeof readRecord?.baseTs === "number") merged.baseTs = readRecord.baseTs;
    if (typeof readRecord?.parentTs === "number") merged.parentTs = readRecord.parentTs;
    if (typeof folderRecord?.folderBaseTs === "number") merged.folderBaseTs = folderRecord.folderBaseTs;
    if (typeof folderRecord?.folderParentTs === "number") merged.folderParentTs = folderRecord.folderParentTs;
    return merged;
}

function finalizeStateForSync(state) {
    const st = normalizeState(state);
    const finalized = {
        schema: "mailstate-sync/v7",
        client: { clientId: st.client.clientId, createdAt: st.client.createdAt },
        updatedAt: st.updatedAt,
        accounts: [...st.accounts],
        folders: Object.fromEntries(Object.entries(st.folders).map(([email, paths]) => [email, [...paths]])),
        folderStates: Object.fromEntries(Object.entries(st.folderStates).map(([email, folders]) => [email,
            Object.fromEntries(Object.entries(folders).map(([path, record]) => [path,
                { empty: !!record.empty, messageCount: record.messageCount, ts: record.ts }]))
        ])),
        messages: {}
    };
    for (const [hid, rec] of Object.entries(st.messages ?? {})) {
        const finalizedRecord = {
            accountEmail: (rec?.accountEmail ?? "").toString().trim().toLowerCase(),
            folderPath: rec?.folderPath ?? null,
            read: !!rec?.read,
            ts: typeof rec?.ts === "number" ? rec.ts : 0,
            folderTs: folderRecordTs(rec)
        };
        if (validFolderNames(rec?.folderNames)) finalizedRecord.folderNames = [...rec.folderNames];
        const parentTs = typeof rec?.baseTs === "number" ? rec.baseTs : rec?.parentTs;
        if (typeof parentTs === "number") finalizedRecord.parentTs = parentTs;
        const folderParentTs = typeof rec?.folderBaseTs === "number" ? rec.folderBaseTs : rec?.folderParentTs;
        if (typeof folderParentTs === "number") finalizedRecord.folderParentTs = folderParentTs;
        finalized.messages[hid] = finalizedRecord;
    }
    return finalized;
}

function syncStatesDiffer(a, b) {
    const am = a?.messages ?? {};
    const bm = b?.messages ?? {};
    const keys = new Set([...Object.keys(am), ...Object.keys(bm)]);
    for (const hid of keys) {
        if (!am[hid] || !bm[hid]) return true;
        if (!!am[hid].read !== !!bm[hid].read) return true;
        if (!sameFolderLocation(am[hid], bm[hid])) return true;
        if (validFolderNames(am[hid].folderNames) && !validFolderNames(bm[hid].folderNames)) return true;
    }
    return false;
}

function mergeFolderStateRecords(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = typeof a.ts === "number" ? a.ts : 0;
    const tb = typeof b.ts === "number" ? b.ts : 0;
    if (ta !== tb) return tb > ta ? b : a;
    // On an exact tie, retaining a folder is the safe outcome.
    if (!!a.empty !== !!b.empty) return a.empty ? b : a;
    return a;
}

function mergeByTs(localState, dropboxState) {
    const l = normalizeState(localState);
    const d = normalizeState(dropboxState);

    const out = normalizeState(emptyState());
    out.client = l.client;

    const acc = new Set([...(l.accounts ?? []), ...(d.accounts ?? [])]);
    out.accounts = Array.from(acc);

    out.folders = {};
    for (const email of out.accounts) {
        const a = new Set([...(l.folders?.[email] ?? []), ...(d.folders?.[email] ?? [])]);
        out.folders[email] = Array.from(a);
    }

    out.folderStates = {};
    const folderStateEmails = new Set([
        ...Object.keys(l.folderStates ?? {}),
        ...Object.keys(d.folderStates ?? {})
    ]);
    for (const email of folderStateEmails) {
        const localFolders = l.folderStates?.[email] ?? {};
        const dropboxFolders = d.folderStates?.[email] ?? {};
        const paths = new Set([...Object.keys(localFolders), ...Object.keys(dropboxFolders)]);
        out.folderStates[email] = {};
        for (const path of paths) {
            out.folderStates[email][path] = mergeFolderStateRecords(localFolders[path], dropboxFolders[path]);
        }
    }

    const lm = l.messages ?? {};
    const dm = d.messages ?? {};
    const keys = new Set([...Object.keys(lm), ...Object.keys(dm)]);
    out.messages = {};
    for (const hid of keys) {
        const A = lm[hid];
        const B = dm[hid];
        out.messages[hid] = mergeMessageRecords(A, B);
    }

    out.schema = "mailstate-sync/v7";
    out.updatedAt = new Date().toISOString();
    return out;
}

// ---------------- Local canonical + mirror file ----------------
async function loadLocalState() {
    const { [KEY_LOCAL_STATE]: s } = await browser.storage.local.get(KEY_LOCAL_STATE);
    const st = normalizeState(s);
    if (!s) await browser.storage.local.set({ [KEY_LOCAL_STATE]: st });
    return st;
}
async function saveLocalState(state) {
    const st = normalizeState(state);
    st.updatedAt = new Date().toISOString();
    await browser.storage.local.set({ [KEY_LOCAL_STATE]: st });
    return st;
}

async function exportLocalMirrorFile(state) {
    const opt = await getOptions();
    if (!isSyncConfigured(opt) || !opt.localMirrorEnabled || !await browser.permissions.contains({ permissions: ["downloads"] })) return;

    const text = JSON.stringify(finalizeStateForSync(state), null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
        await browser.downloads.download({
            url,
            filename: opt.localMirrorFilename || DEFAULT_LOCAL_MIRROR_FILENAME,
            conflictAction: "overwrite",
            saveAs: false
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function setSyncMeta(patch) {
    const { [KEY_SYNC_META]: cur } = await browser.storage.local.get(KEY_SYNC_META);
    await browser.storage.local.set({ [KEY_SYNC_META]: { ...(cur ?? {}), ...(patch ?? {}) } });
}
async function ensureRetryAlarm() {
    if (!isSyncConfigured(await getOptions())) {
        clearTimeout(localFlushTimer);
        localFlushTimer = null;
        await browser.alarms.clear(RETRY_ALARM);
        return;
    }
    await browser.alarms.create(RETRY_ALARM, { periodInMinutes: RETRY_PERIOD_MIN });
}

function scheduleLocalFlush() {
    if (localFlushTimer) clearTimeout(localFlushTimer);
    localFlushTimer = setTimeout(() => {
        localFlushTimer = null;
        enqueueSyncOperation(flushLocalAndMaybeUpload).catch(() => { });
    }, LOCAL_FLUSH_DEBOUNCE_MS);
}

// ---------------- Dropbox state I/O ----------------
async function loadDropboxState(token) {
    const res = await dropboxContentFetch("files/download", { path: DROPBOX_STATE_PATH }, null, token);
    if (res.status === 409) {
        const error = await res.json();
        if (String(error.error_summary ?? "").startsWith("path/not_found")) return { state: emptyState(), rev: null };
    }
    if (!res.ok) throw new Error(`Dropbox download failed: ${res.status}`);

    const meta = parseDropboxApiResultHeader(res);
    const rev = meta?.rev ?? null;

    const text = await res.text();
    let state;
    try {
        state = JSON.parse(text, (key, value) => {
            if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe key");
            return value;
        });
        if (!state || typeof state !== "object" || !state.messages || typeof state.messages !== "object" || Array.isArray(state.messages)) throw new Error("Invalid state");
        if (state.schema && !/^mailstate-sync\/v[1-7]$/.test(state.schema)) throw new Error("Unsupported schema");
        for (const record of Object.values(state.messages)) {
            if (!record || typeof record.accountEmail !== "string" || typeof record.folderPath !== "string" ||
                !record.folderPath.startsWith("/") || typeof record.read !== "boolean" || !Number.isFinite(record.ts)) throw new Error("Invalid record");
        }
    } catch {
        throw new Error("Dropbox state.json is invalid or unsupported. It was not overwritten.");
    }
    return { state: normalizeState(state), rev };
}

async function uploadDropboxState(token, state, rev) {
    if (!rev) await ensureDropboxBackupDirectory(token);
    const mode = rev ? { ".tag": "update", update: rev } : { ".tag": "add" };
    const args = { path: DROPBOX_STATE_PATH, mode, autorename: false, mute: true, strict_conflict: true };
    const body = JSON.stringify(finalizeStateForSync(state), null, 2);

    const res = await dropboxContentFetch("files/upload", args, body, token);
    if (res.status === 409) return { ok: false, conflict: true };
    if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status}`);

    const meta = await res.json();
    return { ok: true, rev: meta?.rev ?? null };
}

// Cloud is the folder-state source during a pull, while message read conflicts
// are still resolved with the read-wins rule.
async function pullCloudStateAndApply() {
    await requireSyncOptions();
    const token = await getDropboxToken();
    if (!token) throw new Error("Dropbox not connected");
    await setSyncMeta({ applyPending: true });

    const { state: cloud } = await loadDropboxState(token);

    const local = await loadLocalState();
    const next = mergeByTs(local, cloud);
    next.client = local.client;
    next.folders = cloud.folders;
    next.folderStates = cloud.folderStates;
    next.updatedAt = new Date().toISOString();

    // Commit the baseline only after Thunderbird has accepted the changes.
    const result = await applyStateToThunderbird(next);
    const saved = await saveLocalState(next);
    await exportLocalMirrorFile(saved);

    const pending = syncStatesDiffer(next, cloud);
    await setSyncMeta({ pending, applyPending: false, lastError: "" });

    dlog("PULL: saved cloud->local", summarizeState(saved));
    return result;
}

// ---------------- Upload pipeline with conflict resolution ----------------
function selectLocalStateForSync(state, options, validEmails) {
    const selected = new Set(options.selectedAccountEmails.filter(email => validEmails.has(email)));
    const scoped = { ...state, accounts: [], folders: {}, folderStates: {}, messages: {} };
    for (const email of selected) {
        scoped.accounts.push(email);
        scoped.folders[email] = (state.folders?.[email] ?? []).filter(path => folderAllowed(path, options.includeFolderPrefixes));
        scoped.folderStates[email] = Object.fromEntries(Object.entries(state.folderStates?.[email] ?? {})
            .filter(([path]) => folderAllowed(path, options.includeFolderPrefixes)));
    }
    for (const [id, record] of Object.entries(state.messages ?? {})) {
        if (selected.has(record.accountEmail) && folderAllowed(record.folderPath, options.includeFolderPrefixes)) scoped.messages[id] = record;
    }
    return scoped;
}

async function uploadNowWithConflictResolution() {
    const options = await requireSyncOptions();
    const token = await getDropboxToken();
    if (!token) throw new Error("Dropbox not connected");

    const local = selectLocalStateForSync(await loadLocalState(), options, await buildEmailToLocalAccountIdMap());
    const r = await loadDropboxState(token);
    let drop = r.state;
    let rev = r.rev;

    const merged = mergeByTs(local, drop);

    for (let attempt = 0; attempt < 3; attempt++) {
        const uploadCandidate = finalizeStateForSync(merged);
        const up = await uploadDropboxState(token, uploadCandidate, rev);
        if (up.ok) {
            const { [KEY_SYNC_META]: meta } = await browser.storage.local.get(KEY_SYNC_META);
            const resolutionDelta = computeDelta(local, uploadCandidate);
            if (meta?.applyPending) {
                await applyStateToThunderbird(uploadCandidate);
            } else if (resolutionDelta.toProcess.length > 0) {
                await applyDeltaToThunderbird(resolutionDelta);
            }

            const saved = await saveLocalState(uploadCandidate);
            await exportLocalMirrorFile(saved);
            await setSyncMeta({ lastUploadOk: true, lastUploadAt: Date.now(), lastError: "", pending: false, applyPending: false });

            // ✅ Aがupload成功したrevをwatchにも保存（Bの検知精度UP）
            if (up.rev) {
                await saveDropboxWatch({ lastStateRev: up.rev, lastCheckedAt: Date.now() });
            }

            dlog("UPLOAD: ok", summarizeState(saved), { rev: up.rev ?? null });
            return { ok: true };
        }
        if (up.conflict) {
            dwarn("UPLOAD: conflict, retry", { attempt });
            const r2 = await loadDropboxState(token);
            drop = r2.state;
            rev = r2.rev;
            const merged2 = mergeByTs(merged, drop);
            merged.messages = merged2.messages;
            merged.folders = merged2.folders;
            merged.folderStates = merged2.folderStates;
            merged.accounts = merged2.accounts;
            merged.updatedAt = merged2.updatedAt;
            continue;
        }
        break;
    }

    throw new Error("Dropbox conflict: retry exceeded");
}

async function markUploadPending(errorText) {
    await setSyncMeta({ lastUploadOk: false, lastError: errorText ?? "upload failed", pending: true });
    await ensureRetryAlarm();
    derr("UPLOAD: pending", { errorText });
}

async function flushLocalAndMaybeUpload() {
    if (!isSyncConfigured(await getOptions())) return;
    const { [KEY_SYNC_META]: meta } = await browser.storage.local.get(KEY_SYNC_META);
    if (!meta?.pending) return;

    try {
        if (!await getDropboxToken()) return;
        // Mirror export is batched here instead of being executed for every local message event.
        await exportLocalMirrorFile(await loadLocalState());
        await uploadNowWithConflictResolution();
    } catch (e) {
        await markUploadPending(String(e?.message ?? e));
    }
}

// ---------------- Account email mapping ----------------
async function getAccountEmailKey(accountId) {
    const account = await browser.accounts.get(accountId, false);
    if (!isPop3Account(account)) return "";
    return String(account?.identities?.[0]?.email ?? "").trim().toLowerCase();
}

async function buildEmailToLocalAccountIdMap() {
    const map = new Map();
    const accounts = await browser.accounts.list(true);
    dlog("accounts.list", { count: accounts?.length ?? 0 });

    for (const acc of accounts) {
        if (!isPop3Account(acc)) continue;
        const email = await getAccountEmailKey(acc.id);
        dlog("accounts.item", { id: acc.id, name: acc.name, type: acc.type, email });
        if (email && !map.has(email)) map.set(email, acc.id);
    }

    dlog("email->accountId map", Array.from(map.entries()));
    return map;
}

// ---------------- Folder helpers (apply + scan) ----------------
async function getAccountRootFolder(accountId) {
    const acct = await browser.accounts.get(accountId, true);
    return acct?.rootFolder ?? null;
}
function splitFolderPath(path) {
    return (path ?? "").split("/").filter(Boolean);
}

function folderReference(folder) {
    return folder?.id ?? folder;
}

function getFolderNamesByPath(root) {
    const namesByPath = new Map();
    function visit(folder, names) {
        if (!folder) return;
        namesByPath.set(folder.path, names);
        for (const child of folder.subFolders ?? []) visit(child, [...names, child.name]);
    }
    visit(root, []);
    return namesByPath;
}

async function ensureFolderPath(accountId, folderPath, folderNames) {
    const root = await getAccountRootFolder(accountId);
    if (!root) return null;

    // API paths are opaque identifiers, not display-name hierarchies. In
    // particular /Inbox is commonly displayed as a localized folder name.
    const exact = collectAllFolders(root).find(folder => folder.path === folderPath);
    if (exact) return exact;

    // New records carry the actual hierarchy for folders absent on this PC.
    // Legacy records can still reuse existing API path prefixes.
    const hasNames = validFolderNames(folderNames);
    const pathParts = splitFolderPath(folderPath);
    const parts = hasNames ? folderNames : pathParts;
    let current = root;
    let legacyPath = "";
    for (const [index, part] of parts.entries()) {
        legacyPath += `/${pathParts[index]}`;
        const subFolders = current?.subFolders ?? [];
        let next = (pathParts.length === parts.length && subFolders.find(folder => folder.path === legacyPath)) ||
            subFolders.find(folder => folder.name === part) || null;
        if (!next) {
            if (!browser.folders || typeof browser.folders.create !== "function") {
                derr("folders.create unavailable", { accountId, folderPath, part });
                return null;
            }
            try {
                next = await browser.folders.create(folderReference(current), part);
                if (!Array.isArray(current.subFolders)) current.subFolders = [];
                current.subFolders.push(next);
                dlog("folders.create ok", { accountId, folderPath, part, createdId: next?.id ?? null });
            } catch (e) {
                derr("folders.create failed", { accountId, folderPath, part }, e);
                return null;
            }
        }
        current = next;
    }
    return current;
}

function collectAllFolders(rootFolder) {
    const out = [];
    const stack = [rootFolder];
    while (stack.length) {
        const f = stack.pop();
        if (!f) continue;
        out.push(f);
        const subs = f.subFolders || [];
        for (const sf of subs) stack.push(sf);
    }
    return out;
}

function isProtectedFolder(folder, rootFolder) {
    if (!folder || folder === rootFolder) return true;
    if (folder.id && rootFolder?.id && folder.id === rootFolder.id) return true;
    const path = (folder.path ?? "").toString();
    if (!path || path === "/") return true;

    const specialUse = Array.isArray(folder.specialUse)
        ? folder.specialUse
        : (folder.specialUse ? [folder.specialUse] : []);
    if (specialUse.length) return true;

    // Thunderbird versions differ in how standard folders expose their role.
    // A non-empty type is treated as protected; custom folders normally have
    // no type (or "none").
    const type = (folder.type ?? "").toString().toLowerCase();
    return !!type && type !== "none" && type !== "normal";
}

function sourceEmptyFolderPaths(state, email) {
    const result = [];
    const folderStates = state?.folderStates?.[email] ?? {};
    for (const [path, folderState] of Object.entries(folderStates)) {
        if (folderState?.empty === true) result.push(path);
    }
    return result;
}

async function deleteFoldersEmptyOnBothSides(state, selectedEmails, emailToLocalId, prefixes) {
    const options = await getOptions();
    if (!isSyncConfigured(options) || !options.cleanupEmptyFolders || !await browser.permissions.contains({ permissions: ["messagesDelete"] })) {
        return { deleted: 0 };
    }
    if (!browser.folders || typeof browser.folders.delete !== "function") {
        dwarn("folders.delete unavailable; empty-folder cleanup skipped");
        return { deleted: 0, skippedNotEmpty: 0, skippedProtected: 0, failed: 0 };
    }

    let deleted = 0;
    let skippedNotEmpty = 0;
    let skippedProtected = 0;
    let failed = 0;

    for (const [email, accountId] of emailToLocalId.entries()) {
        if (!selectedEmails.has(email)) continue;

        const root = await getAccountRootFolder(accountId);
        if (!root) continue;

        const liveFolders = collectAllFolders(root);
        const liveByPath = new Map(liveFolders.map((folder) => [(folder.path ?? "").toString(), folder]));
        const remainingPaths = new Set(liveByPath.keys());
        const candidates = sourceEmptyFolderPaths(state, email)
            .filter((path) => folderAllowed(path, prefixes))
            .sort((a, b) => splitFolderPath(b).length - splitFolderPath(a).length);

        for (const path of candidates) {
            const folder = liveByPath.get(path);
            if (!folder) continue;
            if (isProtectedFolder(folder, root)) {
                skippedProtected++;
                continue;
            }

            const prefix = path.endsWith("/") ? path : `${path}/`;
            const hasRemainingChild = Array.from(remainingPaths).some((other) => other !== path && other.startsWith(prefix));
            if (hasRemainingChild) {
                skippedNotEmpty++;
                continue;
            }

            const folderRef = folderReference(folder);
            const destinationResult = await listAllMessagesInFolderResult(folderRef, path);
            if (!destinationResult.ok) {
                failed++;
                continue;
            }
            if (destinationResult.messages.length !== 0) {
                skippedNotEmpty++;
                continue;
            }

            try {
                await browser.folders.delete(folderRef);
                remainingPaths.delete(path);
                deleted++;
                dlog("EMPTY FOLDER delete ok", { email, accountId, path, folderId: folder.id ?? null });
            } catch (e) {
                failed++;
                derr("EMPTY FOLDER delete failed", { email, accountId, path, folderId: folder.id ?? null }, e);
            }
        }
    }

    return { deleted, skippedNotEmpty, skippedProtected, failed };
}

// progress notify
async function reportApplyProgress(payload) {
    try { await browser.runtime.sendMessage({ type: "PROGRESS_APPLY", payload }); } catch (e) {
        dwarn("sendMessage(PROGRESS_APPLY) failed", e);
    }
}

async function buildHeaderIndexForAccounts(emailToLocalId, selectedEmails, prefixes, forcedFoldersByEmail = null) {
    const index = new Map(); // headerMessageId -> [message]
    const foldersByAccount = new Map(); // accountId -> Map(folderPath -> folder)
    const selectedSet = selectedEmails ?? new Set();

    for (const [email, accountId] of emailToLocalId.entries()) {
        if (!selectedSet.has(email)) continue;

        const root = await getAccountRootFolder(accountId);
        if (!root) continue;

        const allFolders = collectAllFolders(root);
        const folderMap = new Map();
        for (const f of allFolders) folderMap.set((f.path ?? '').toString(), f);
        foldersByAccount.set(accountId, folderMap);

        let scanFolders;
        const forced = forcedFoldersByEmail?.get(email);
        if (forced && forced.size) {
            scanFolders = Array.from(forced)
                .filter(path => folderAllowed(path, prefixes))
                .map(path => folderMap.get(path))
                .filter(Boolean);
        } else {
            scanFolders = allFolders.filter(f => folderAllowed(f.path, prefixes));
        }

        dlog('buildHeaderIndex: scan start', { email, accountId, folders: scanFolders.length });
        for (const folder of scanFolders) {
            if (folder === root) continue; // Account roots do not contain mail.
            const listed = await listAllMessagesInFolderResult(folderReference(folder), folder.path);
            if (!listed.ok) throw new Error(`Message indexing failed: ${folder.path}`);
            const msgs = listed.messages;
            for (const m of msgs) {
                const hid = m.headerMessageId;
                if (!hid) continue;
                if (!index.has(hid)) index.set(hid, []);
                index.get(hid).push(m);
            }
            if (index.size % 2000 === 0) await new Promise(r => setTimeout(r, 0));
        }
        dlog('buildHeaderIndex: scan done', { email, headers: index.size });
    }

    return { index, foldersByAccount };
}

function addForcedFolder(map, email, path) {
    const e = (email ?? '').toString().trim().toLowerCase();
    const p = (path ?? '').toString();
    if (!e || !p) return;
    if (!map.has(e)) map.set(e, new Set());
    map.get(e).add(p);
}

// ---------------- Apply delta only (speed) ----------------
function recordsEqual(a, b) {
    if (!a || !b) return false;
    return (a.accountEmail ?? "") === (b.accountEmail ?? "") &&
        !!a.read === !!b.read &&
        sameFolderLocation(a, b);
}

function computeDelta(localState, cloudState) {
    const L = normalizeState(localState);
    const C = normalizeState(cloudState);

    const toProcess = []; // [{ hid, rec }]
    const scanFoldersNeeded = new Map(); // email -> Set(location hints)

    for (const [hid, crec] of Object.entries(C.messages ?? {})) {
        const lrec = L.messages?.[hid] ?? null;

        // Flags and tags are intentionally ignored.
        if (lrec && recordsEqual(lrec, crec)) continue;

        let readNeedsApply = !lrec || !!lrec.read !== !!crec?.read;
        const folderNeedsApply = !lrec || !sameFolderLocation(lrec, crec);

        // A local read value wins over a conflicting cloud unread value, but
        // that must not suppress an independent resolved folder move.
        const lts = typeof lrec?.ts === "number" ? lrec.ts : 0;
        const cloudFollowsLocal =
            (typeof crec?.baseTs === "number" && crec.baseTs === lts) ||
            (typeof crec?.parentTs === "number" && crec.parentTs === lts);
        if (lrec?.read === true && crec?.read !== true && !cloudFollowsLocal) readNeedsApply = false;
        if (!readNeedsApply && !folderNeedsApply) continue;

        toProcess.push({ hid, rec: crec, applyRead: readNeedsApply, applyFolder: folderNeedsApply });

        const email = (crec?.accountEmail ?? "").toString().trim().toLowerCase();
        const p = (crec?.folderPath ?? "").toString();
        if (email && p && p !== "/") addForcedFolder(scanFoldersNeeded, email, p);
        const lp = (lrec?.folderPath ?? "").toString();
        if (email && lp && lp !== "/") addForcedFolder(scanFoldersNeeded, email, lp);
    }

    return { toProcess, scanFoldersNeeded };
}

async function applyResolvedMessageRecord(
    message,
    rec,
    accountId,
    destinationCache,
    logPrefix,
    { applyRead = true, applyFolder = true } = {}
) {
    let applied = 0;
    let moved = 0;
    const errors = [];

    if (applyRead && typeof rec?.read === "boolean" && message.read !== rec.read) {
        try {
            await browser.messages.update(message.id, { read: rec.read });
            applied = 1;
            dlog(`${logPrefix} UPDATE ok`, { msgId: message.id, read: rec.read });
        } catch (e) {
            derr(`${logPrefix} update failed`, { msgId: message.id, read: rec.read }, e);
            errors.push(`update ${message.id}: ${String(e?.message ?? e)}`);
        }
    }

    const targetPath = (rec?.folderPath ?? "").toString();
    if (applyFolder && targetPath && message.folder?.path !== targetPath) {
        if (!browser.messages || typeof browser.messages.move !== "function") {
            derr(`${logPrefix} move unavailable`, { msgId: message.id, targetPath });
            errors.push(`move ${message.id}: messages.move unavailable`);
            return { applied, moved, errors };
        }

        const cacheKey = `${accountId}\n${targetPath}`;
        let destination = destinationCache.get(cacheKey);
        if (!destination) {
            destination = await ensureFolderPath(accountId, targetPath, rec.folderNames);
            if (destination) destinationCache.set(cacheKey, destination);
        }

        if (!destination) {
            derr(`${logPrefix} move skipped: destination folder unavailable`, { msgId: message.id, targetPath });
            errors.push(`move ${message.id}: destination folder unavailable (${targetPath})`);
            return { applied, moved, errors };
        }

        // The same named hierarchy can have a different API path on this PC.
        if (message.folder?.path === destination.path) return { applied, moved, errors };

        try {
            await browser.messages.move([message.id], folderReference(destination));
            moved = 1;
            dlog(`${logPrefix} MOVE ok`, {
                msgId: message.id,
                from: message.folder?.path ?? null,
                to: targetPath
            });
        } catch (e) {
            derr(`${logPrefix} move failed`, {
                msgId: message.id,
                from: message.folder?.path ?? null,
                to: targetPath
            }, e);
            errors.push(`move ${message.id}: ${String(e?.message ?? e)}`);
        }
    }

    return { applied, moved, errors };
}

async function applyDeltaToThunderbird(delta) {
    if (IS_APPLYING) throw new Error("apply already running");
    IS_APPLYING = true;

    try {
        const opt = await getOptions();
        if (!isSyncConfigured(opt)) throw new Error("Sync is not configured.");

        const selectedEmails = new Set(opt.selectedAccountEmails ?? []);
        const emailToLocalId = await buildEmailToLocalAccountIdMap();
        const prefixes = opt.includeFolderPrefixes ?? [];

        let applied = 0, moved = 0, notFound = 0, skippedNoAccount = 0;
        const errors = [];

        // Search all selected folders because the message may currently be in
        // a different local folder than the resolved destination.
        const { index } = await buildHeaderIndexForAccounts(emailToLocalId, selectedEmails, prefixes, null);

        dlog("DELTA apply start", { total: delta.toProcess.length, indexedHeaders: index.size });

        let processed = 0;
        const destinationCache = new Map();
        for (const { hid, rec, applyRead, applyFolder } of delta.toProcess) {
            processed++;

            const email = (rec?.accountEmail ?? "").toString().trim().toLowerCase();
            if (!email) { skippedNoAccount++; continue; }
            if (!selectedEmails.has(email)) continue;

            if (!folderAllowed(rec.folderPath, prefixes)) continue;

            const localAccountId = emailToLocalId.get(email);
            if (!localAccountId) { skippedNoAccount++; continue; }

            const found = (index.get(hid) ?? []).filter(m => m.folder?.accountId === localAccountId);
            if (!found.length) { notFound++; continue; }

            for (const m of found) {
                const result = await applyResolvedMessageRecord(
                    m,
                    rec,
                    localAccountId,
                    destinationCache,
                    "DELTA",
                    { applyRead, applyFolder }
                );
                applied += result.applied;
                moved += result.moved;
                errors.push(...result.errors);
            }

            if (processed % 50 === 0) await new Promise(r => setTimeout(r, 0));
        }

        if (errors.length) throw new Error(`Thunderbird apply failed (${errors.length}): ${errors.slice(0, 3).join("; ")}`);
        dlog("DELTA apply done", { total: delta.toProcess.length, applied, moved, notFound, skippedNoAccount, suppressed: SUPPRESSED_EVENTS });
        SUPPRESSED_EVENTS = 0;

        return { ok: true, total: delta.toProcess.length, applied, moved, notFound, skippedNoAccount };
    } finally {
        IS_APPLYING = false;
    }
}

// ---------------- Dropbox watch polling (B: detect & apply) ----------------
async function pollDropboxChangesAndApply() {
    const opt = await getOptions();
    if (!isSyncConfigured(opt) || !opt.watchEnabled) return;

    const token = await getDropboxToken();
    if (!token) return;

    // A failed full reconciliation must retry even when the saved baseline
    // already matches Dropbox (including caches written by older versions).
    const { [KEY_SYNC_META]: meta } = await browser.storage.local.get(KEY_SYNC_META);
    if (meta?.applyPending) {
        await enqueueSyncOperation(async () => {
            await pullCloudStateAndApply();
            scheduleLocalFlush();
        });
        return;
    }

    const w = await loadDropboxWatch();
    if (!w.cursor) {
        await ensureDropboxCursorInitialized();
        return;
    }

    // longpoll: detect if any changes
    let lp;
    try {
        lp = await dropboxLongpoll(w.cursor, 30);
    } catch (e) {
        derr("Dropbox longpoll failed", e);
        return;
    }

    if (lp?.backoff) {
        dwarn("Dropbox longpoll backoff", lp.backoff);
        return;
    }

    if (!lp?.changes) {
        await saveDropboxWatch({ lastCheckedAt: Date.now() });
        return;
    }

    // changes=true -> continue -> inspect state.json rev
    let cont;
    try {
        cont = await dropboxListBackupDir(token, w.cursor);
    } catch (e) {
        derr("Dropbox list_folder/continue failed", e);
        return;
    }

    const entry = findStateJsonEntry(cont);
    const newCursor = cont.cursor;

    if (!entry?.rev) {
        await saveDropboxWatch({ cursor: newCursor, lastCheckedAt: Date.now() });
        dlog("Dropbox changes but state.json entry not found; cursor advanced only");
        return;
    }

    if (entry.rev === w.lastStateRev) {
        await saveDropboxWatch({ cursor: newCursor, lastCheckedAt: Date.now() });
        dlog("Dropbox cursor advanced but state.json rev unchanged; skip");
        return;
    }

    dlog("Dropbox updated detected", { oldRev: w.lastStateRev, newRev: entry.rev });

    // Download cloud state
    let cloud;
    try {
        cloud = (await loadDropboxState(token)).state;
    } catch (e) {
        derr("Dropbox state download failed", e);
        await saveDropboxWatch({ lastCheckedAt: Date.now() });
        return;
    }

    // Longpoll and download run outside the queue so local events remain fast.
    return enqueueSyncOperation(async () => {
        if (!isSyncConfigured(await getOptions()) || !await hasDropboxConnection()) return;
        // Resolve read conflicts against local state. Folder emptiness still comes
        // from the downloaded source snapshot, not from the destination.
        const local = await loadLocalState();
        const resolved = mergeByTs(local, cloud);
        resolved.client = local.client;
        resolved.folders = cloud.folders;
        resolved.folderStates = cloud.folderStates;
        const delta = computeDelta(local, resolved);

        dlog("Dropbox delta computed", { total: delta.toProcess.length });

        // Apply only delta (speed)
        if (delta.toProcess.length > 0) {
            await applyDeltaToThunderbird(delta);
        } else {
            dlog("Delta is empty; nothing to apply");
        }

        const selectedEmails = new Set(opt.selectedAccountEmails ?? []);
        const emailToLocalId = await buildEmailToLocalAccountIdMap();
        const folderResult = await deleteFoldersEmptyOnBothSides(
            resolved,
            selectedEmails,
            emailToLocalId,
            opt.includeFolderPrefixes ?? []
        );

        const saved = await saveLocalState(resolved);
        await exportLocalMirrorFile(saved);

        const syncConflictResolved = syncStatesDiffer(resolved, cloud);
        if (syncConflictResolved) {
            await setSyncMeta({ pending: true });
            scheduleLocalFlush();
        }

        await saveDropboxWatch({
            cursor: newCursor,
            lastStateRev: entry.rev,
            lastCheckedAt: Date.now()
        });

        dlog("Dropbox apply complete", { foldersDeleted: folderResult.deleted, syncConflictResolved });
    });
}

// ---------------- Apply full state to Thunderbird (manual or fallback) ----------------
async function applyStateToThunderbird(state) {
    if (IS_APPLYING) throw new Error("apply already running");
    IS_APPLYING = true;

    try {
        const opt = await getOptions();
        dlog("APPLY options", opt);
        dlog("APPLY start: state summary", summarizeState(state));

        // API self-check
        dlog("API check", {
            hasFolders: !!browser.folders,
            hasFoldersCreate: !!(browser.folders && browser.folders.create),
            hasFoldersDelete: !!(browser.folders && browser.folders.delete),
            hasMessagesMove: !!(browser.messages && browser.messages.move),
            hasFoldersGet: !!(browser.folders && browser.folders.get),
            hasFoldersGetSubFolders: !!(browser.folders && browser.folders.getSubFolders),
        });

        if (!isSyncConfigured(opt)) {
            dlog("APPLY skipped: disabled");
            throw new Error("disabled");
        }

        const selectedEmails = new Set(opt.selectedAccountEmails ?? []);
        const emailToLocalId = await buildEmailToLocalAccountIdMap();
        const prefixes = opt.includeFolderPrefixes ?? [];

        const entries = Object.entries(state?.messages ?? {});
        const total = entries.length;

        const sampleEntries = entries.slice(0, 10).map(([hid, rec]) => ({
            hid,
            accountEmail: rec?.accountEmail,
            folderPath: rec?.folderPath,
            read: rec?.read,
            ts: rec?.ts,
            folderTs: rec?.folderTs
        }));
        dlog("APPLY entries sample(10)", sampleEntries);

        let processed = 0;
        let applied = 0, moved = 0, notFound = 0, skippedNoAccount = 0;
        const errors = [];

        await reportApplyProgress({ stage: "indexing", processed, total, applied, moved, notFound, skippedNoAccount });
        const { index } = await buildHeaderIndexForAccounts(emailToLocalId, selectedEmails, prefixes, null);
        dlog("APPLY header index ready", { indexedHeaders: index.size });

        await reportApplyProgress({ stage: "start", processed, total, applied, moved, notFound, skippedNoAccount });

        const destinationCache = new Map();
        for (const [hid, rec] of entries) {
            processed++;

            const email = (rec?.accountEmail ?? "").toString().trim().toLowerCase();
            if (!email) { skippedNoAccount++; continue; }
            if (!selectedEmails.has(email)) continue;

            if (!folderAllowed(rec.folderPath, prefixes)) continue;

            const localAccountId = emailToLocalId.get(email);
            if (!localAccountId) { skippedNoAccount++; continue; }

            const found = (index.get(hid) ?? []).filter(m => m.folder?.accountId === localAccountId);
            if (!found.length) {
                notFound++;
                if (notFound <= DEBUG.logFirstNNotFound) dlog("NOT_FOUND(index miss)", { hid, email, want: rec?.folderPath });
                continue;
            }

            if (DEBUG.logQueryResultsSample && processed <= 10) {
                dlog("INDEX sample", { hid, hits: found.length, firstId: found[0]?.id, folder: found[0]?.folder?.path });
            }

            for (const m of found) {
                const result = await applyResolvedMessageRecord(m, rec, localAccountId, destinationCache, "APPLY");
                applied += result.applied;
                moved += result.moved;
                errors.push(...result.errors);
            }

            if (processed % DEBUG.everyN === 0) {
                dlog("APPLY progress", { processed, total, applied, moved, notFound, skippedNoAccount });
            }

            if (processed % 200 === 0) {
                await reportApplyProgress({ stage: "running", processed, total, applied, moved, notFound, skippedNoAccount });
            }

            if (processed % 50 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (errors.length) throw new Error(`Thunderbird apply failed (${errors.length}): ${errors.slice(0, 3).join("; ")}`);
        const folderResult = await deleteFoldersEmptyOnBothSides(state, selectedEmails, emailToLocalId, prefixes);

        await reportApplyProgress({ stage: "done", processed: total, total, applied, moved, notFound, skippedNoAccount, foldersDeleted: folderResult.deleted });
        dlog("APPLY done", { applied, moved, notFound, skippedNoAccount, foldersDeleted: folderResult.deleted, suppressedEvents: SUPPRESSED_EVENTS });
        SUPPRESSED_EVENTS = 0;

        return { ok: true, applied, moved, notFound, skippedNoAccount, foldersDeleted: folderResult.deleted };
    } finally {
        IS_APPLYING = false;
    }
}

// ---------------- Local update on events (A: diff updates) ----------------
async function updateLocalFromMessage(message, override = {}) {
    if (IS_APPLYING) {
        SUPPRESSED_EVENTS++;
        if (SUPPRESSED_EVENTS <= 20 || SUPPRESSED_EVENTS % 200 === 0) {
            dlog("event suppressed during apply", {
                suppressed: SUPPRESSED_EVENTS,
                headerMessageId: message?.headerMessageId,
                folder: message?.folder?.path,
                read: message?.read
            });
        }
        return;
    }

    const opt = await getOptions();
    if (!isSyncConfigured(opt)) return;

    const selected = new Set(opt.selectedAccountEmails ?? []);

    const hid = message?.headerMessageId;
    if (!hid) return;

    const accountId = message?.folder?.accountId ?? null;
    const email = override.accountEmail ?? (accountId ? await getAccountEmailKey(accountId) : "");
    if (!email) return;
    if (!selected.has(email)) return;

    const folderPath = override.folderPath ?? message.folder?.path ?? null;

    if (!folderAllowed(folderPath, opt.includeFolderPrefixes)) return;

    const state = await loadLocalState();
    const prev = state.messages?.[hid];
    const read = typeof override.read === "boolean" ? override.read : !!message.read;
    const updateRead = override.updateRead !== false;
    const updateFolder = override.updateFolder !== false;
    const folderNames = updateFolder && accountId
        ? getFolderNamesByPath(await getAccountRootFolder(accountId)).get(folderPath)
        : null;
    ensureAccountAndFolder(state, email, folderPath);
    const folderStateChanged = markFolderNonEmpty(state, email, folderPath);
    let rec;
    let recordChanged = false;

    if (!prev) {
        rec = makeRecord({ accountEmail: email, folderPath, read });
        // Reading an untracked message only observes its current location.
        // It must not compete with a move already recorded by another client.
        if (!updateFolder) rec.folderTs = 0;
        recordChanged = true;
    } else {
        // Legacy records use ts for both fields. Freeze the folder timestamp
        // before changing read history so a read event cannot invent a move.
        rec = { ...prev, accountEmail: email, folderTs: folderRecordTs(prev) };

        if (updateRead && !!prev.read !== read) {
            const baseTs = typeof prev.baseTs === "number"
                ? prev.baseTs
                : (typeof prev.ts === "number" ? prev.ts : undefined);
            rec.read = read;
            rec.ts = typeof baseTs === "number" ? Math.max(Date.now(), baseTs + 1) : Date.now();
            if (typeof baseTs === "number") rec.baseTs = baseTs;
            recordChanged = true;
        }

        if (updateFolder && !sameFolderLocation(prev, { folderPath, folderNames })) {
            const previousFolderTs = folderRecordTs(prev);
            const folderBaseTs = typeof prev.folderBaseTs === "number"
                ? prev.folderBaseTs
                : previousFolderTs;
            rec.folderPath = folderPath ?? null;
            rec.folderTs = Math.max(Date.now(), folderBaseTs + 1);
            rec.folderBaseTs = folderBaseTs;
            recordChanged = true;
        }
    }

    if (validFolderNames(folderNames) && JSON.stringify(rec.folderNames) !== JSON.stringify(folderNames)) {
        rec.folderNames = folderNames;
        recordChanged = true;
    }

    if (!recordChanged && !folderStateChanged) return;

    upsertMessageRecord(state, hid, rec);

    await saveLocalState(state);

    await setSyncMeta({ pending: true });
    scheduleLocalFlush();
}

// ---------------- Full scan -> rebuild local canonical (selected only) ----------------
async function listAllMessagesInFolderResult(folderId, folderPathForLog = "") {
    const all = [];
    let page;
    try {
        page = await browser.messages.list(folderId);
    } catch (e) {
        dwarn("messages.list failed -> skip folder", { folderId, folderPathForLog }, e);
        return { ok: false, messages: all };
    }

    while (true) {
        if (page?.messages?.length) all.push(...page.messages);
        if (!page?.id) break;

        try {
            page = await browser.messages.continueList(page.id);
        } catch (e) {
            dwarn("messages.continueList failed -> stop paging", { folderId, folderPathForLog }, e);
            return { ok: false, messages: all };
        }
    }
    return { ok: true, messages: all };
}

async function listAllMessagesInFolder(folderId, folderPathForLog = "") {
    const result = await listAllMessagesInFolderResult(folderId, folderPathForLog);
    return result.messages;
}

async function fullScanToLocalState({ startup = false } = {}) {
    const opt = await getOptions();
    if (!isSyncConfigured(opt)) return { ok: false, error: "Sync is not configured." };

    const selectedEmails = new Set(opt.selectedAccountEmails ?? []);
    if (!selectedEmails.size) return { ok: false, error: "no selected accounts" };

    const prefixes = opt.includeFolderPrefixes ?? [];
    const emailToLocalId = await buildEmailToLocalAccountIdMap();

    const prev = await loadLocalState();
    const next = normalizeState(emptyState());
    next.client = prev.client;
    next.accounts = [];
    next.folders = {};
    next.folderStates = {};
    next.messages = startup ? { ...prev.messages } : {};
    const scanTimestamp = Date.now();

    let accountsCount = 0;
    let foldersConsidered = 0;
    let foldersScanned = 0;
    let messagesScanned = 0;
    let recordsSaved = 0;

    for (const email of selectedEmails) {
        const accountId = emailToLocalId.get(email);
        if (!accountId) continue;

        accountsCount++;

        const root = await getAccountRootFolder(accountId);
        if (!root) continue;

        const folders = collectAllFolders(root);
        const namesByPath = getFolderNamesByPath(root);

        for (const folder of folders) {
            const fpath = folder.path ?? null;
            foldersConsidered++;

            if (!folderAllowed(fpath, prefixes)) continue;

            foldersScanned++;
            ensureAccountAndFolder(next, email, fpath);

            const folderMessages = await listAllMessagesInFolderResult(folderReference(folder), folder.path);
            const msgs = folderMessages.messages;
            messagesScanned += msgs.length;
            if (folderMessages.ok) setFolderState(next, email, fpath, msgs.length, scanTimestamp);

            for (const m of msgs) {
                const hid = m.headerMessageId;
                if (!hid) continue;

                const prevRec = prev.messages?.[hid];
                if (startup && prevRec) {
                    // An observed location is not a new user move. Preserve the
                    // recorded intent until it has been reconciled with Dropbox.
                    // A manual full scan remains available to adopt offline edits.
                    const folderNames = namesByPath.get(fpath);
                    if (sameFolderLocation(prevRec, { folderPath: fpath, folderNames }) &&
                        !validFolderNames(prevRec.folderNames) && validFolderNames(folderNames)) {
                        next.messages[hid] = { ...prevRec, folderNames };
                    }
                    recordsSaved++;
                    continue;
                }
                const read = !!m.read;
                const folderPath = fpath ?? m.folder?.path ?? null;
                const folderNames = namesByPath.get(folderPath);
                const readUnchanged = prevRec && !!prevRec.read === read;
                const folderUnchanged = prevRec && sameFolderLocation(prevRec, { folderPath, folderNames });
                const previousTs = typeof prevRec?.ts === "number" ? prevRec.ts : 0;
                const previousFolderTs = folderRecordTs(prevRec);
                const keepTs = readUnchanged && previousTs ? previousTs : Math.max(scanTimestamp, previousTs + 1);
                const keepFolderTs = startup && !prevRec ? 0 : folderUnchanged
                    ? previousFolderTs
                    : Math.max(scanTimestamp, previousFolderTs + 1);
                const baseTs = readUnchanged && typeof prevRec?.baseTs === "number"
                    ? prevRec.baseTs
                    : (!readUnchanged && typeof prevRec?.baseTs === "number"
                        ? prevRec.baseTs
                        : (!readUnchanged && typeof prevRec?.ts === "number" ? prevRec.ts : undefined));
                const folderBaseTs = folderUnchanged && typeof prevRec?.folderBaseTs === "number"
                    ? prevRec.folderBaseTs
                    : (!folderUnchanged && typeof prevRec?.folderBaseTs === "number"
                        ? prevRec.folderBaseTs
                        : (!folderUnchanged && prevRec ? previousFolderTs : undefined));

                const rec = {
                    accountEmail: email,
                    folderPath,
                    read,
                    ts: keepTs,
                    folderTs: keepFolderTs
                };
                if (validFolderNames(folderNames)) rec.folderNames = folderNames;
                if (typeof baseTs === "number") rec.baseTs = baseTs;
                if (readUnchanged && typeof prevRec?.parentTs === "number") rec.parentTs = prevRec.parentTs;
                if (typeof folderBaseTs === "number") rec.folderBaseTs = folderBaseTs;
                if (folderUnchanged && typeof prevRec?.folderParentTs === "number") {
                    rec.folderParentTs = prevRec.folderParentTs;
                }

                const existed = !!next.messages[hid];
                upsertMessageRecord(next, hid, rec);
                if (!existed && next.messages[hid]) recordsSaved++;
            }
        }
    }

    next.updatedAt = new Date().toISOString();
    next.schema = "mailstate-sync/v7";

    const saved = await saveLocalState(next);
    await exportLocalMirrorFile(saved);
    await setSyncMeta({ pending: true });

    dlog("FULL_SCAN: saved", summarizeState(saved), { accountsCount, foldersConsidered, foldersScanned, messagesScanned, recordsSaved });
    return { ok: true, accounts: accountsCount, foldersConsidered, foldersScanned, messagesScanned, recordsSaved };
}

async function hydrateMessageIfNeeded(msg) {
    // onUpdated などで msg が薄い場合に備える
    const id = msg?.id;
    if (!id) return msg;

    const hasHid = !!msg?.headerMessageId;
    const hasFolder = !!msg?.folder?.accountId && typeof msg?.folder?.path === "string";

    if (hasHid && hasFolder) return msg;

    try {
        const full = await browser.messages.get(id);
        // get()は folder 等が揃いやすい
        return full ?? msg;
    } catch (e) {
        derr("hydrateMessageIfNeeded: messages.get failed", { id }, e);
        return msg;
    }
}


// ---------------- Event listeners ----------------
async function* messageListPages(firstPage) {
    let page = firstPage;
    while (page) {
        yield page.messages ?? [];
        if (!page.id) return;
        page = await browser.messages.continueList(page.id);
    }
}

browser.messages.onNewMailReceived.addListener(
    async (folder, messageList) => {
        if (suppressApplyEvent()) return;
        return enqueueSyncOperation(async () => {
            try {
                for await (const messages of messageListPages(messageList)) {
                    for (const m of messages) {
                        await updateLocalFromMessage(m, { folderPath: m.folder?.path ?? folder?.path ?? null });
                    }
                }
            } catch (e) {
                derr("onNewMailReceived handler failed", e);
            }
        });
    },
    true
);

browser.messages.onUpdated.addListener(async (message, changedProperties) => {
    if (suppressApplyEvent()) return;
    return enqueueSyncOperation(async () => {
        try {
            if (typeof changedProperties?.read !== "boolean") return;

            const full = await hydrateMessageIfNeeded(message);

            // changedProperties.read が来ているのに full.read が更新前の値のケースに保険で override
            await updateLocalFromMessage(full, {
                read: changedProperties.read,
                updateRead: true,
                updateFolder: false
            });
        } catch (e) {
            derr("onUpdated handler failed", e);
        }
    });
});

browser.messages.onMoved.addListener(async (originalMessages, movedMessages) => {
    if (suppressApplyEvent()) return;
    return enqueueSyncOperation(async () => {
        try {
            for await (const messages of messageListPages(movedMessages)) {
                for (const message of messages) {
                    const full = await hydrateMessageIfNeeded(message);
                    await updateLocalFromMessage(full, {
                        folderPath: full?.folder?.path ?? null,
                        updateRead: false,
                        updateFolder: true
                    });
                }
            }
        } catch (e) {
            derr("onMoved handler failed", e);
        }
    });
});


// Retry + Watch alarms
browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm?.name === RETRY_ALARM) {
        await enqueueSyncOperation(flushLocalAndMaybeUpload).catch((e) => derr("flushLocalAndMaybeUpload failed (alarm)", e));
        return;
    }
    if (alarm?.name === WATCH_ALARM) {
        await pollDropboxChangesAndApply().catch((e) => derr("pollDropboxChangesAndApply failed (alarm)", e));
        return;
    }
});

// ---------------- UI messages ----------------
async function handleRuntimeMessage(msg) {
    try {
        dlog("onMessage", msg?.type);

        if (msg?.type === "SAVE_SETTINGS") {
            const options = normalizeOptions(msg.options);
            if (options.enabled && !isSyncConfigured(options)) throw new Error("Select at least one POP3 account and accept the data disclosure before enabling sync.");
            const validAccounts = await buildEmailToLocalAccountIdMap();
            if (options.selectedAccountEmails.some(email => !validAccounts.has(email))) throw new Error("Select an available POP3 account.");
            for (const [flag, permission] of [["localMirrorEnabled", "downloads"], ["cleanupEmptyFolders", "messagesDelete"]]) {
                if (options[flag] && !await browser.permissions.contains({ permissions: [permission] })) throw new Error(`Permission required: ${permission}`);
            }
            const appKey = String(msg.appKey ?? "").trim();
            const previous = await getDropboxConfig();
            if (appKey !== previous.appKey || options.dataConsentVersion !== MailStateSettings.CONSENT_VERSION) await disconnectDropbox();
            await browser.storage.local.set({ [KEY_OPTIONS]: options, [KEY_DROPBOX_CFG]: { appKey } });
            await ensureRetryAlarm();
            await ensureWatchAlarm();
            return { ok: true };
        }

        if (msg?.type === "DROPBOX_DISCONNECT") return await disconnectDropbox();
        if (msg?.type === "CLEAR_LOCAL_DATA") {
            await disconnectDropbox();
            await browser.storage.local.remove([KEY_LOCAL_STATE, KEY_SYNC_META, KEY_OPTIONS, KEY_DROPBOX_CFG]);
            await ensureRetryAlarm();
            await ensureWatchAlarm();
            return { ok: true };
        }

        if (msg?.type === "OPTIONS_UPDATED") {
            await ensureRetryAlarm();
            await ensureWatchAlarm();
            return { ok: true };
        }

        if (msg?.type === "DROPBOX_OPEN_AUTH_PAGE") return await openDropboxAuthPage();
        if (msg?.type === "DROPBOX_EXCHANGE_CODE") return await exchangeCodeForToken(msg.code);

        if (msg?.type === "DROPBOX_STATUS_REFRESH") {
            return { ok: true, connected: await hasDropboxConnection() };
        }

        // Manual: cloud pull, read-wins resolution, then full apply
        if (msg?.type === "PULL_AND_APPLY") {
            const r = await pullCloudStateAndApply();
            scheduleLocalFlush();
            return { ok: true, ...r };
        }

        // Manual: cloud pull then delta apply (speed)
        if (msg?.type === "PULL_AND_APPLY_DELTA") {
            await requireSyncOptions();
            const token = await getDropboxToken();
            if (!token) return { ok: false, error: "Dropbox not connected" };

            const cloud = (await loadDropboxState(token)).state;
            const local = await loadLocalState();
            const resolved = mergeByTs(local, cloud);
            resolved.client = local.client;
            resolved.folders = cloud.folders;
            resolved.folderStates = cloud.folderStates;
            const delta = computeDelta(local, resolved);
            const ar = await applyDeltaToThunderbird(delta);

            const opt = await getOptions();
            const selectedEmails = new Set(opt.selectedAccountEmails ?? []);
            const emailToLocalId = await buildEmailToLocalAccountIdMap();
            const folderResult = await deleteFoldersEmptyOnBothSides(
                resolved,
                selectedEmails,
                emailToLocalId,
                opt.includeFolderPrefixes ?? []
            );

            const saved = await saveLocalState(resolved);
            await exportLocalMirrorFile(saved);

            if (syncStatesDiffer(resolved, cloud)) {
                await setSyncMeta({ pending: true });
                scheduleLocalFlush();
            }

            return { ok: true, ...ar, foldersDeleted: folderResult.deleted, deltaCount: delta.toProcess.length };
        }

        // Manual: local full scan then upload
        if (msg?.type === "FULL_SCAN_LOCAL") {
            await requireSyncOptions();
            const r = await fullScanToLocalState();
            try { await uploadNowWithConflictResolution(); }
            catch (e) {
                const error = String(e?.message ?? e);
                await markUploadPending(error);
                return { ...r, uploadOk: false, uploadError: error };
            }
            return { ...r, uploadOk: true };
        }

        if (msg?.type === "UPLOAD_NOW") {
            try {
                await uploadNowWithConflictResolution();
                return { ok: true };
            } catch (e) {
                await markUploadPending(String(e?.message ?? e));
                return { ok: false, error: String(e?.message ?? e) };
            }
        }

        if (msg?.type === "WATCH_POLL_NOW") {
            await pollDropboxChangesAndApply();
            return { ok: true };
        }

    } catch (e) {
        derr("onMessage handler failed", msg?.type, e);
        return { ok: false, error: String(e?.message ?? e) };
    }

    return { ok: false, error: "unknown message" };
}

const UI_MESSAGE_TYPES = new Set(["SAVE_SETTINGS", "OPTIONS_UPDATED", "DROPBOX_DISCONNECT", "CLEAR_LOCAL_DATA", "DROPBOX_OPEN_AUTH_PAGE", "DROPBOX_EXCHANGE_CODE", "DROPBOX_STATUS_REFRESH", "PULL_AND_APPLY", "PULL_AND_APPLY_DELTA", "FULL_SCAN_LOCAL", "UPLOAD_NOW", "WATCH_POLL_NOW"]);
browser.runtime.onMessage.addListener((msg, sender) => {
    if (!UI_MESSAGE_TYPES.has(msg?.type)) return undefined;
    if (sender?.id && sender.id !== browser.runtime.id) return undefined;
    return msg.type === "WATCH_POLL_NOW" ? handleRuntimeMessage(msg) : enqueueSyncOperation(() => handleRuntimeMessage(msg));
});

// ---------------- Startup ----------------
async function onStartupHandler() {
    await ensureRetryAlarm();
    await ensureWatchAlarm();
    if (!isSyncConfigured(await getOptions())) return;

    // 起動時API診断
    dlog("API check", {
        hasFolders: !!browser.folders,
        hasFoldersCreate: !!(browser.folders && browser.folders.create),
        hasFoldersDelete: !!(browser.folders && browser.folders.delete),
        hasMessagesMove: !!(browser.messages && browser.messages.move),
        hasFoldersGet: !!(browser.folders && browser.folders.get),
        hasFoldersGetSubFolders: !!(browser.folders && browser.folders.getSubFolders),
    });

    // 起動時に fullScan（選択範囲）でローカルを再構築
    await fullScanToLocalState({ startup: true }).catch((e) => derr("startup fullScan failed", e));

    // Dropbox token があるなら watch 初期化 + merge
    try {
        const token = await getDropboxToken();
        if (token) {
            await ensureDropboxCursorInitialized().catch((e) => derr("ensureDropboxCursorInitialized failed (startup)", e));

            // Full reconciliation also repairs a move previously acknowledged
            // in storage without actually being performed in Thunderbird.
            await pullCloudStateAndApply();

            const { [KEY_SYNC_META]: meta } = await browser.storage.local.get(KEY_SYNC_META);
            if (meta?.pending) {
                await flushLocalAndMaybeUpload();
            }

            dlog("startup merged", summarizeState(await loadLocalState()));
        } else {
            dlog("startup: no dropbox token");
        }
    } catch (e) {
        await markUploadPending(String(e?.message ?? e));
    }
}

browser.runtime.onInstalled.addListener(() => {
    enqueueSyncOperation(async () => {
        if ((await getOptions()).dataConsentVersion !== MailStateSettings.CONSENT_VERSION) await browser.runtime.openOptionsPage();
        await onStartupHandler();
    }).catch((e) => derr("onInstalled failed", e));
});
if (browser.runtime.onStartup) {
    browser.runtime.onStartup.addListener(() => { enqueueSyncOperation(onStartupHandler).catch((e) => derr("onStartup failed", e)); });
}
