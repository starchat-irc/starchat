import { escapeHtml } from '../core/formatting.js';

const files = import.meta.glob('./templates/*.html', { query: '?raw', import: 'default', eager: true });

/** Template sources by name ("chat-header"), plain HTML with Alpine.js attributes. */
export const templates = Object.fromEntries(
    Object.entries(files).map(([path, html]) => [path.replace(/^.*\/|\.html$/g, ''), html]),
);

const PARTIAL_PATTERN = /\{\{> ([a-z0-9-]+) \}\}/g;
const TEXT_PATTERN = /\{\{ t\('([a-z0-9_]+)'\) \}\}/g;
const MAX_DEPTH = 10;

/**
 * Build the HTML for a template: "{{> name }}" inserts another template,
 * "{{ t('key') }}" inserts the escaped text. Texts that change at runtime use
 * Alpine bindings (x-text="t('key')") and are left alone.
 *
 * @param {string} name
 * @param {(key: string) => string} t
 * @param {Object<string, string>} [source] Template set, defaults to the bundled templates.
 * @return {string}
 */
export function renderTemplate(name, t, source = templates) {
    const expand = (current, depth, chain) => {
        if (!Object.hasOwn(source, current)) {
            throw new Error(`Unknown template "${current}"${chain.length ? ` (included from ${chain.at(-1)})` : ''}`);
        }
        if (depth > MAX_DEPTH || chain.includes(current)) {
            throw new Error(`Template include loop: ${[...chain, current].join(' > ')}`);
        }
        return source[current].replace(PARTIAL_PATTERN, (match, partial) => expand(partial, depth + 1, [...chain, current]));
    };

    return expand(name, 0, []).replace(TEXT_PATTERN, (match, key) => escapeHtml(t(key)));
}
