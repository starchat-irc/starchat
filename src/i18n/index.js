import de from './de.json';
import en from './en.json';

/** Bundled UI texts per language. English is the fallback for missing keys. */
export const messages = { de, en };

export const FALLBACK_LANGUAGE = 'en';

/**
 * Language code for a locale ("de-DE" -> "de"), English when the language is not bundled.
 * A list (navigator.languages) gives the first bundled language of the user's order.
 *
 * @param {string|string[]} [locale]
 * @return {string}
 */
export function resolveLanguage(locale) {
    const candidates = Array.isArray(locale) ? locale : [locale];
    for (const candidate of candidates) {
        const language = String(candidate || '').toLowerCase().split(/[-_]/)[0];
        if (Object.hasOwn(messages, language)) return language;
    }
    return FALLBACK_LANGUAGE;
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
 * @param {string|string[]} [options.locale] e.g. "de-DE", "en" or navigator.languages
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
