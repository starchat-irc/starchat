/**
 * Settings of the hostable web page, read from config.json next to index.html.
 * Only known keys are passed on, so the file cannot hand functions or other options
 * to mountChat(). The format is described in docs/hosting.md.
 */

const THEMES = ['auto', 'dark', 'light'];

/** Keys of config.json that go to mountChat() unchanged when they have the right type. */
const STRING_OPTIONS = ['primaryServer', 'defaultChannel', 'appName', 'ctcpVersion', 'defaultQuitMessage'];

function isHttps(value) {
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

function text(value, max) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';
}

/**
 * @param {unknown} data Parsed config.json.
 * @param {string} [search] Query string of the page (?server=…&lang=…&theme=…).
 * @return {{ options: Object, title: string, notice: string, links: { label: string, url: string }[],
 *            modules: string[]|null, push: boolean }}
 */
export function readWebConfig(data, search = '') {
    const config = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const options = {};

    for (const key of STRING_OPTIONS) {
        const value = text(config[key], 200);
        if (value) options[key] = value;
    }
    if (config.serverList === false || config.serverList === 'default' || isHttps(config.serverList)) {
        options.serverList = config.serverList;
    }
    if (typeof config.locale === 'string' || (Array.isArray(config.locale) && config.locale.every(item => typeof item === 'string'))) {
        options.locale = config.locale;
    }
    if (THEMES.includes(config.theme)) options.theme = config.theme;
    if (config.overrides && typeof config.overrides === 'object' && !Array.isArray(config.overrides)) {
        options.overrides = Object.fromEntries(Object.entries(config.overrides).filter(([, value]) => typeof value === 'string'));
    }

    // Links in the address: another server, language or theme for this visit
    if (config.urlParameters !== false) {
        const params = new URLSearchParams(search);
        const server = text(params.get('server'), 200);
        if (server && /^[a-z0-9.-]+$/i.test(server)) options.primaryServer = server;
        const lang = text(params.get('lang'), 20);
        if (lang) options.locale = lang;
        if (THEMES.includes(params.get('theme'))) options.theme = params.get('theme');
    }

    const links = (Array.isArray(config.links) ? config.links : [])
        .filter(link => link && text(link.label, 60) && isHttps(link.url))
        .map(link => ({ label: text(link.label, 60), url: link.url }));

    return {
        options,
        title: text(config.title, 80) || options.appName || 'StarChat',
        notice: text(config.notice, 300),
        links,
        modules: Array.isArray(config.modules) ? config.modules.filter(name => typeof name === 'string') : null,
        push: config.push !== false,
    };
}

/**
 * Query string for push-sw.js: notifications carry the app name and open this page.
 *
 * @param {{ appName?: string }} options
 * @param {string} pagePath Path of the chat page, e.g. "/chat/".
 */
export function pushWorkerUrl(options, pagePath) {
    const directory = pagePath.endsWith('/') ? pagePath : pagePath.replace(/[^/]*$/, '');
    const params = new URLSearchParams({ name: options.appName || 'StarChat', chat: directory, icon: `${directory}favicon.svg` });
    return `${directory}push-sw.js?${params}`;
}
