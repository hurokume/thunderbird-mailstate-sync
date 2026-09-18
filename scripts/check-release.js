/* SPDX-License-Identifier: MPL-2.0 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
const manifest = JSON.parse(read("manifest.json"));
const files = JSON.parse(read("release-files.json"));
assert.equal(new Set(files).size, files.length, "Duplicate packaged files");
for (const file of files) {
    assert.ok(!file.includes("..") && !path.isAbsolute(file), `Unsafe release path: ${file}`);
    assert.ok(fs.statSync(path.join(root, file)).isFile(), `Missing release file: ${file}`);
    if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", path.join(root, file)]);
}
assert.equal(manifest.version, JSON.parse(read("package.json")).version);
assert.equal(manifest.manifest_version, 3);
assert.ok(Number.parseInt(manifest.browser_specific_settings.gecko.strict_min_version, 10) >= 128);
assert.ok(manifest.permissions.includes("sensitiveDataUpload"));
assert.ok(!manifest.permissions.includes("notifications"));
assert.ok(!manifest.permissions.includes("downloads") && manifest.optional_permissions.includes("downloads"));
assert.ok(!manifest.permissions.includes("messagesDelete") && manifest.optional_permissions.includes("messagesDelete"));
assert.deepEqual(manifest.host_permissions.slice().sort(), ["https://api.dropboxapi.com/*", "https://content.dropboxapi.com/*", "https://notify.dropboxapi.com/*"].sort());
assert.ok(!manifest.browser_specific_settings.gecko.update_url, "ATN distributes updates");
assert.ok(!manifest.experiment_apis, "No Experiment API needed");
for (const file of [...manifest.background.scripts, manifest.options_ui.page, ...Object.values(manifest.icons)]) assert.ok(files.includes(file), `Unpackaged entry: ${file}`);
const locales = Object.fromEntries(["en", "ja"].map(locale => [locale, JSON.parse(read(`_locales/${locale}/messages.json`))]));
assert.equal(manifest.default_locale, "en");
assert.deepEqual(Object.keys(locales.en).sort(), Object.keys(locales.ja).sort(), "Locale keys differ");
const referencedKeys = new Set();
for (const file of files.filter(file => /\.(html|js)$/.test(file))) {
    const content = read(file);
    for (const match of content.matchAll(/data-i18n="([^"]+)"|translate\("([^"]+)"/g)) referencedKeys.add(match[1] || match[2]);
    if (file.endsWith(".html")) {
        assert.ok(!/<script\b[^>]*src=["']https?:/i.test(content), "Remote code is forbidden");
        assert.ok(!/\son\w+=/i.test(content), "Inline handlers violate CSP");
        for (const match of content.matchAll(/(?:src|href)="([^"#]+)"/g)) {
            if (!/^https?:/.test(match[1])) assert.ok(files.includes(match[1]), `Unpackaged HTML reference: ${match[1]}`);
        }
    }
}
for (const value of [manifest.name, manifest.description]) referencedKeys.add(value.match(/^__MSG_(.+)__$/)[1]);
for (const key of referencedKeys) {
    for (const locale of ["en", "ja"]) assert.ok(locales[locale][key]?.message, `Missing ${locale} message: ${key}`);
}
for (const key of Object.keys(locales.en)) {
    const placeholders = value => [...value.matchAll(/\$\d+/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(locales.en[key].message), placeholders(locales.ja[key].message), `Placeholder mismatch: ${key}`);
}
console.log(`Release checks passed: ${files.length} packaged files, ${Object.keys(locales.en).length} messages per locale, version ${manifest.version}.`);
