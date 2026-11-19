import de from './de.json';
import en from './en.json';

/** Bundled UI texts per language. English is the fallback for missing keys. */
export const messages = { de, en };

export const FALLBACK_LANGUAGE = 'en';

/**
 * Language code for a locale ("de-DE" -> "de"), English when the language is not bundled.
 *
 * @param {string} [locale]
 * @return {string}
 */
export function resolveLanguage(locale) {
    const language = String(locale || '').toLowerCase().split(/[-_]/)[0];
    return Object.hasOwn(messages, language) ? language : FALLBACK_LANGUAGE;
}

function replaceParams(text, params) {
    // Longest names first, so ":count" does not eat the start of ":countTotal"
    const names = Object.keys(params).sort((a, b) => b.length - a.length);
    let result = text;
    for (const name of names) {
        result = result.replaceAll(`:${name}`, String(params[name]));
    }
    return result;
}

/**
 * Create t(key, params). Texts use ":name" placeholders. ":app" is filled with
 * the app name, so editions can show their own name without changing the texts.
 *
 * @param {Object} [options]
 * @param {string} [options.locale] e.g. "de-DE" or "en"
 * @param {Object<string, string>} [options.overrides] Texts that replace bundled ones (edition specific wording).
 * @param {string} [options.appName]
 * @return {(key: string, params?: Object<string, string|number>) => string}
 */
export function createTranslator({ locale, overrides = {}, appName = 'StarChat' } = {}) {
    const language = resolveLanguage(locale);
    const primary = messages[language];
    const fallback = messages[FALLBACK_LANGUAGE];

    return function t(key, params = {}) {
        const text = overrides[key] ?? primary[key] ?? fallback[key] ?? key;
        return replaceParams(String(text), { app: appName, ...params });
    };
}
