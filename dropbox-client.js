/* SPDX-License-Identifier: MPL-2.0 */
// Dropbox transport and PKCE authentication. Credentials stay in storage.local;
// callers receive access tokens only, never refresh tokens or response bodies.
const DROPBOX_CREDENTIALS_KEY = "dropboxCredentials";
const DROPBOX_SCOPES = ["files.metadata.read", "files.content.read", "files.content.write"];
const DROPBOX_HOSTS = MailStateSettings.DROPBOX_HOSTS;
let tokenRefreshPromise = null;
let authorizationGeneration = 0;
const activeDropboxRequests = new Set();

async function hasDropboxConnection() {
    const stored = await browser.storage.local.get([DROPBOX_CREDENTIALS_KEY, TOKEN_KEY]);
    return !!(stored[DROPBOX_CREDENTIALS_KEY]?.accessToken || stored[TOKEN_KEY]);
}

async function requireDataConsent() {
    const options = await getOptions();
    if (options.dataConsentVersion !== MailStateSettings.CONSENT_VERSION) {
        throw new Error("Review and accept the data disclosure in MailState Sync settings first.");
    }
}

async function dropboxFetch(url, options) {
    await requireDataConsent();
    const controller = new AbortController();
    activeDropboxRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
        return await fetch(url, { ...options, credentials: "omit", redirect: "error", signal: controller.signal });
    } finally {
        clearTimeout(timeout);
        activeDropboxRequests.delete(controller);
    }
}

async function getDropboxConfig() {
    const { [KEY_DROPBOX_CFG]: config } = await browser.storage.local.get(KEY_DROPBOX_CFG);
    return { appKey: String(config?.appKey ?? "").trim() };
}

async function requestDropboxToken(form) {
    const response = await dropboxFetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString()
    });
    if (!response.ok) throw new Error(`Dropbox authentication failed (${response.status}). Reconnect in settings.`);
    const result = await response.json();
    if (typeof result.access_token !== "string" || !result.access_token) throw new Error("Dropbox did not return an access token.");
    return result;
}

async function getDropboxToken() {
    await requireDataConsent();
    const stored = await browser.storage.local.get([DROPBOX_CREDENTIALS_KEY, TOKEN_KEY]);
    const credentials = stored[DROPBOX_CREDENTIALS_KEY];
    // Compatibility for existing installations; reconnect to obtain refresh support.
    if (!credentials) return stored[TOKEN_KEY] ?? null;
    if (credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
    if (!credentials.refreshToken) throw new Error("Dropbox authorization expired. Reconnect in settings.");
    if (!tokenRefreshPromise) {
        const generation = authorizationGeneration;
        tokenRefreshPromise = (async () => {
            const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: credentials.appKey });
            const result = await requestDropboxToken(form);
            if (generation !== authorizationGeneration) throw new Error("Dropbox disconnected.");
            const next = { ...credentials, accessToken: result.access_token, expiresAt: Date.now() + (Number(result.expires_in) || 14400) * 1000 };
            await browser.storage.local.set({ [DROPBOX_CREDENTIALS_KEY]: next });
            return next.accessToken;
        })().finally(() => { tokenRefreshPromise = null; });
    }
    return tokenRefreshPromise;
}

function base64urlFromBytes(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function openDropboxAuthPage() {
    await requireDataConsent();
    const { appKey } = await getDropboxConfig();
    if (!/^[a-zA-Z0-9_-]+$/.test(appKey)) throw new Error("Enter your Dropbox App key in settings.");
    if (!await browser.permissions.contains({ origins: DROPBOX_HOSTS })) throw new Error("Allow Dropbox access in settings first.");
    const verifier = base64urlFromBytes(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64urlFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    await browser.storage.local.set({ [KEY_PKCE]: { verifier, appKey, createdAt: Date.now() } });
    const params = new URLSearchParams({ client_id: appKey, response_type: "code", token_access_type: "offline", code_challenge: challenge, code_challenge_method: "S256", scope: DROPBOX_SCOPES.join(" ") });
    await browser.windows.openDefaultBrowser(`https://www.dropbox.com/oauth2/authorize?${params}`);
    return { ok: true };
}

async function exchangeCodeForToken(code) {
    await requireDataConsent();
    const { appKey } = await getDropboxConfig();
    const { [KEY_PKCE]: pkce } = await browser.storage.local.get(KEY_PKCE);
    if (!pkce || pkce.appKey !== appKey || Date.now() - pkce.createdAt > 15 * 60_000) {
        throw new Error("Authorization session expired. Open the Dropbox authorization page again.");
    }
    code = String(code ?? "").trim();
    if (!code) throw new Error("Enter the authorization code from Dropbox.");
    const result = await requestDropboxToken(new URLSearchParams({ grant_type: "authorization_code", code, client_id: appKey, code_verifier: pkce.verifier }));
    const credentials = {
        appKey, accessToken: result.access_token, refreshToken: result.refresh_token ?? null,
        expiresAt: Date.now() + (Number(result.expires_in) || 14400) * 1000
    };
    await browser.storage.local.set({ [DROPBOX_CREDENTIALS_KEY]: credentials });
    await browser.storage.local.remove([KEY_PKCE, TOKEN_KEY, KEY_DROPBOX_WATCH]);
    await setSyncMeta({ applyPending: true });
    await ensureRetryAlarm();
    await ensureWatchAlarm();
    return { ok: true };
}

async function disconnectDropbox() {
    // Local disconnect is always possible, even with an expired token or offline.
    // The user can revoke this device's grant on Dropbox's Connected apps page.
    authorizationGeneration++;
    for (const controller of activeDropboxRequests) controller.abort();
    await browser.storage.local.remove([DROPBOX_CREDENTIALS_KEY, TOKEN_KEY, KEY_PKCE, KEY_DROPBOX_WATCH, "dropboxAuth"]);
    clearTimeout(localFlushTimer);
    localFlushTimer = null;
    return { ok: true };
}

async function dropboxContentFetch(route, args, body, token) {
    return dropboxFetch(`https://content.dropboxapi.com/2/${route}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify(args), "Content-Type": "application/octet-stream" }, body
    });
}

function parseDropboxApiResultHeader(response) {
    const raw = response.headers.get("dropbox-api-result");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function dropboxApiFetch(route, body, token) {
    const response = await dropboxFetch(`https://api.dropboxapi.com/2/${route}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {})
    });
    if (!response.ok) throw new Error(`Dropbox ${route} failed (${response.status}).`);
    return response.json();
}

async function dropboxLongpoll(cursor, timeout = 25) {
    const response = await dropboxFetch("https://notify.dropboxapi.com/2/files/list_folder/longpoll", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cursor, timeout })
    });
    if (!response.ok) throw new Error(`Dropbox change check failed (${response.status}).`);
    return response.json();
}

async function ensureDropboxBackupDirectory(token) {
    const response = await dropboxFetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: DROPBOX_BACKUP_DIR, autorename: false })
    });
    if (response.ok) return;
    if (response.status === 409) {
        const error = await response.json();
        if (String(error.error_summary ?? "").startsWith("path/conflict/folder")) return;
    }
    throw new Error(`Dropbox sync directory unavailable (${response.status}).`);
}
