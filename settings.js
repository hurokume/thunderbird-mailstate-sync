/* SPDX-License-Identifier: MPL-2.0 */
// Shared by the background page and options page. No data is read at load time.
const MailStateSettings = (() => {
    const CONSENT_VERSION = 1;
    const DEFAULT_MIRROR_FILENAME = "thunderbird_backup/state.local.json";

    function sanitizeDownloadRelativePath(path) {
        let value = String(path ?? "").trim().replace(/\\/g, "/");
        value = value.split("/").filter(part => part && part !== "." && part !== "..")
            .map(part => part.replace(/[<>:"|?*\x00-\x1f]/g, "_")).join("/");
        if (!value) return DEFAULT_MIRROR_FILENAME;
        return value.toLowerCase().endsWith(".json") ? value : `${value}.json`;
    }

    function normalizeOptions(value) {
        const options = value ?? {};
        return {
            enabled: options.enabled === true,
            dataConsentVersion: options.dataConsentVersion === CONSENT_VERSION ? CONSENT_VERSION : 0,
            selectedAccountEmails: [...new Set((Array.isArray(options.selectedAccountEmails) ? options.selectedAccountEmails : [])
                .filter(email => typeof email === "string").map(email => email.trim().toLowerCase()).filter(Boolean))],
            includeFolderPrefixes: [...new Set((Array.isArray(options.includeFolderPrefixes) ? options.includeFolderPrefixes : [])
                .filter(prefix => typeof prefix === "string").map(prefix => {
                    const normalized = `/${prefix.trim().replace(/^\/+|\/+$/g, "")}`;
                    return normalized;
                }))],
            watchEnabled: options.watchEnabled !== false,
            localMirrorEnabled: options.localMirrorEnabled === true,
            localMirrorFilename: sanitizeDownloadRelativePath(options.localMirrorFilename),
            cleanupEmptyFolders: options.cleanupEmptyFolders === true
        };
    }

    function isSyncConfigured(options) {
        return options.enabled && options.dataConsentVersion === CONSENT_VERSION && options.selectedAccountEmails.length > 0;
    }

    function isPop3Account(account) {
        return String(account?.type ?? account?.accountType ?? "").toLowerCase() === "pop3";
    }

    const DROPBOX_HOSTS = ["https://api.dropboxapi.com/*", "https://content.dropboxapi.com/*", "https://notify.dropboxapi.com/*"];
    return Object.freeze({ CONSENT_VERSION, DEFAULT_MIRROR_FILENAME, DROPBOX_HOSTS, normalizeOptions, sanitizeDownloadRelativePath, isSyncConfigured, isPop3Account });
})();
