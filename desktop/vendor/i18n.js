/**
 * i18n helper: loads the translations via electronAPI and provides t().
 *
 * Verwendung in HTML:
 *   <script src="../vendor/i18n.js"></script>
 *   await i18n.load();
 *   i18n.t('key');              // String
 *   i18n.apply();               // alle data-i18n="key" Elemente befüllen
 */

const i18n = (() => {
    let strings = {};

    async function load() {
        try {
            const locale = await window.electronAPI.getLocale();
            strings = await window.electronAPI.getTranslations(locale);
            // <title data-i18n="..."> carries the app name of the edition
            document.querySelectorAll('title[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
        } catch (e) {
            console.warn('i18n: failed to load translations', e);
            strings = {};
        }
        return strings; // return so caller can store reactive copy
    }

    function t(key, fallback) {
        return strings[key] ?? fallback ?? key;
    }

    function apply() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const attr = el.getAttribute('data-i18n-attr');
            const val = t(key);
            if (attr) el.setAttribute(attr, val);
            else el.textContent = val;
        });
    }

    return { load, t, apply };
})();
