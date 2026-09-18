/* SPDX-License-Identifier: MPL-2.0 */
function translate(key, substitutions) {
    return browser.i18n.getMessage(key, substitutions) || key;
}
document.documentElement.lang = browser.i18n.getUILanguage();
for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = translate(element.dataset.i18n);
}
