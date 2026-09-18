/* SPDX-License-Identifier: MPL-2.0 */
const element = id => document.getElementById(id);
const setStatus = text => { element("status").textContent = text; };

async function send(type, payload = {}) {
    const response = await browser.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || translate("unknownError"));
    return response;
}

function readOptions() {
    const consent = element("dataConsent").checked;
    return MailStateSettings.normalizeOptions({
        enabled: element("enabled").checked && consent,
        dataConsentVersion: consent ? MailStateSettings.CONSENT_VERSION : 0,
        selectedAccountEmails: Array.from(document.querySelectorAll("#accountList input:checked")).map(input => input.value),
        includeFolderPrefixes: element("folderPrefixes").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        watchEnabled: element("watchEnabled").checked,
        localMirrorEnabled: element("localMirrorEnabled").checked,
        localMirrorFilename: element("localMirrorFilename").value,
        cleanupEmptyFolders: element("cleanupEmptyFolders").checked
    });
}

async function saveSettings() {
    const options = readOptions();
    await send("SAVE_SETTINGS", { options, appKey: element("dropboxAppKey").value.trim() });
    return options;
}

async function renderAccounts(options) {
    const container = element("accountList");
    container.replaceChildren();
    const accounts = (await browser.accounts.list(false)).filter(MailStateSettings.isPop3Account);
    for (const account of accounts) {
        const email = String(account.identities?.[0]?.email ?? "").trim().toLowerCase();
        const label = document.createElement("label");
        label.className = "acct";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = email;
        checkbox.disabled = !email;
        checkbox.checked = !!email && options.selectedAccountEmails.includes(email);
        const text = document.createElement("span");
        text.textContent = `${account.name || email} — ${email || translate("missingIdentity")}`;
        label.append(checkbox, text);
        container.append(label);
    }
    if (!accounts.length) container.textContent = translate("noAccounts");
}

async function refreshAuthStatus() {
    const response = await send("DROPBOX_STATUS_REFRESH");
    element("authStatus").textContent = translate(response.connected ? "connectedStatus" : "disconnectedStatus");
}

async function load() {
    const stored = await browser.storage.local.get(["options", "dropboxConfig"]);
    const options = MailStateSettings.normalizeOptions(stored.options);
    element("dataConsent").checked = options.dataConsentVersion === MailStateSettings.CONSENT_VERSION;
    for (const key of ["enabled", "watchEnabled", "localMirrorEnabled", "cleanupEmptyFolders"]) element(key).checked = options[key];
    element("folderPrefixes").value = options.includeFolderPrefixes.join("\n");
    element("localMirrorFilename").value = options.localMirrorFilename;
    element("dropboxAppKey").value = stored.dropboxConfig?.appKey ?? "";
    element("dropboxAuthCode").value = "";
    await renderAccounts(options);
    await refreshAuthStatus();
}

// Keep permission requests in the click/change gesture, before asynchronous work.
for (const [id, permission] of [["localMirrorEnabled", "downloads"], ["cleanupEmptyFolders", "messagesDelete"]]) {
    element(id).addEventListener("change", async () => {
        if (!element(id).checked) return;
        try {
            if (!await browser.permissions.request({ permissions: [permission] })) {
                element(id).checked = false;
                setStatus(translate("permissionDenied"));
            }
        } catch (error) {
            element(id).checked = false;
            setStatus(String(error.message));
        }
    });
}

function bind(id, action) {
    element(id).addEventListener("click", async () => {
        try {
            element(id).disabled = true;
            await action();
        } catch (error) {
            setStatus(translate("failed", [String(error.message ?? error)]));
        } finally {
            element(id).disabled = false;
        }
    });
}

bind("save", async () => { await saveSettings(); setStatus(translate("saved")); await refreshAuthStatus(); });
bind("refresh", async () => { await load(); setStatus(translate("reloaded")); });
bind("openAuthPage", async () => {
    if (!element("dataConsent").checked) throw new Error(translate("consentRequired"));
    if (!await browser.permissions.request({ origins: MailStateSettings.DROPBOX_HOSTS })) throw new Error(translate("permissionDenied"));
    await saveSettings();
    await send("DROPBOX_OPEN_AUTH_PAGE");
    setStatus(translate("authOpened"));
});
bind("exchangeCode", async () => {
    await saveSettings();
    try {
        await send("DROPBOX_EXCHANGE_CODE", { code: element("dropboxAuthCode").value.trim() });
        setStatus(translate("connectedStatus"));
    } finally {
        element("dropboxAuthCode").value = "";
    }
    await refreshAuthStatus();
});
bind("disconnect", async () => { await send("DROPBOX_DISCONNECT"); await refreshAuthStatus(); setStatus(translate("disconnectedStatus")); });
bind("checkAuth", refreshAuthStatus);
bind("pullApply", async () => {
    await saveSettings();
    setStatus(translate("working"));
    const response = await send("PULL_AND_APPLY");
    setStatus(translate("applyResult", [String(response.applied), String(response.moved), String(response.foldersDeleted), String(response.notFound)]));
});
bind("uploadNow", async () => { await saveSettings(); setStatus(translate("working")); await send("UPLOAD_NOW"); setStatus(translate("uploaded")); });
bind("fullScanLocal", async () => {
    await saveSettings();
    setStatus(translate("working"));
    const response = await send("FULL_SCAN_LOCAL");
    setStatus(translate("scanResult", [String(response.messagesScanned), response.uploadOk ? translate("uploaded") : String(response.uploadError)]));
});
bind("clearLocalData", async () => {
    if (!window.confirm(translate("clearConfirm"))) return;
    await send("CLEAR_LOCAL_DATA");
    await load();
    setStatus(translate("cleared"));
});

browser.runtime.onMessage.addListener(message => {
    if (message?.type !== "PROGRESS_APPLY") return;
    setStatus(translate("progress", [String(message.payload?.processed ?? 0), String(message.payload?.total ?? 0)]));
});
load().catch(error => setStatus(translate("failed", [String(error.message)])));
