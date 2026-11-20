'use strict';

/**
 * Edition of this app (generated/edition.json, written by scripts/build.mjs) and what the
 * main process derives from it: the API of the primary server (from its discovery file)
 * and the server directory for new connections.
 *
 * Free of Electron imports so it can be unit-tested.
 */

const PUBLIC_SERVER_LIST_URL = 'https://raw.githubusercontent.com/starchat-irc/starchat/main/servers/servers.json';
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

function loadEdition() {
    try {
        return require('./generated/edition.json');
    } catch {
        throw new Error('generated/edition.json is missing. Run "npm run prepare:app" first.');
    }
}

/** URL of the server list the edition uses, or null when it has none. */
function serverListUrl(edition) {
    const source = edition.chat?.serverList ?? 'default';
    if (source === false) return null;
    return source === 'default' ? PUBLIC_SERVER_LIST_URL : source;
}

/**
 * Entries of a StarChat server list (servers/servers.json) in the form the connection
 * dialog uses (see html/shared/connection.js → fromCuratedServer).
 *
 * @param {unknown} list
 * @return {{ name: string, description: string, host: string, port: number, ssl: boolean, websocket_url: string }[]}
 */
function toDirectoryEntries(list, language = 'en') {
    const servers = Array.isArray(list?.servers) ? list.servers : [];
    return servers
        .filter(server => server && typeof server.name === 'string' && (server.irc?.host || server.websocket))
        .map(server => ({
            id: String(server.id || ''),
            name: server.name,
            domain: String(server.domain || ''),
            description: server.description?.[language] || server.description?.en || '',
            host: server.irc?.host || '',
            port: Number(server.irc?.port || 6697),
            ssl: server.irc ? server.irc.tls !== false : true,
            websocket_url: server.irc?.host ? '' : String(server.websocket || ''),
        }));
}

/**
 * Discovery file of the primary server, cached for an hour. Resolves with null when the
 * server has none (a plain IRC server) or is not reachable.
 *
 * @param {{ domain: string, fetchImpl?: typeof fetch, userAgent?: string, now?: () => number }} options
 */
function createDiscoveryCache({ domain, fetchImpl = globalThis.fetch, userAgent = 'StarChat', now = Date.now }) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function load() {
        const url = `https://${domain}/.well-known/starchat.json`;
        try {
            const response = await fetchImpl(url, {
                headers: { 'User-Agent': userAgent, Accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data && typeof data === 'object' ? data : null;
        } catch {
            return null;
        }
    }

    return {
        async get() {
            if (cached && now() - cachedAt < DISCOVERY_TTL_MS) return cached;
            if (!pending) {
                pending = load().then((data) => {
                    pending = null;
                    if (data) {
                        cached = data;
                        cachedAt = now();
                    }
                    return data || cached;
                });
            }
            return pending;
        },

        /** https URL of the API without a trailing slash, or null. */
        async apiBaseUrl() {
            const data = await this.get();
            const url = typeof data?.apiBaseUrl === 'string' ? data.apiBaseUrl : '';
            return /^https:\/\//.test(url) ? url.replace(/\/+$/, '') : null;
        },

        async hasFeature(name) {
            const data = await this.get();
            return Array.isArray(data?.features) && data.features.includes(name) && Boolean(await this.apiBaseUrl());
        },
    };
}

/**
 * Data folder name: dataDir, or the first former folder that exists while dataDir does not.
 *
 * @param {Object} edition
 * @param {(name: string) => boolean} exists whether a folder of that name is in the app data
 */
function chooseDataDir(edition, exists) {
    if (exists(edition.dataDir)) return edition.dataDir;
    return (edition.formerDataDirs || []).find(name => exists(name)) || edition.dataDir;
}

/**
 * Texts of the app windows for one language: bundled texts, the edition's overrides on
 * top, then :app and :network replaced by the app name and the name of the primary network.
 *
 * @param {Object<string, string>} bundled
 * @param {Object} edition
 * @param {string} language
 */
function shellTexts(bundled, edition, language) {
    const merged = { ...bundled, ...(edition.texts?.[language] || {}) };
    const result = {};
    for (const [key, value] of Object.entries(merged)) {
        result[key] = typeof value === 'string'
            ? value.replace(/:app\b/g, edition.appName).replace(/:network\b/g, edition.chat?.networkName || edition.chat?.primaryServer || '')
            : value;
    }
    return result;
}

/** The server list bundled at build time (generated/servers.json), or null. */
function loadBundledServerList() {
    try {
        return require('./generated/servers.json');
    } catch {
        return null;
    }
}

/**
 * Directory entries to show: the downloaded list from the cache, or the bundled one while
 * there is none yet (first start without network).
 *
 * @param {Object[]} cached entries in the cache
 * @param {unknown} bundled bundled server list
 * @param {string} [language]
 */
function directoryEntries(cached, bundled, language = 'en') {
    if (Array.isArray(cached) && cached.length) return cached;
    return toDirectoryEntries(bundled, language);
}

/**
 * Network domain of an older profile without one: the directory entry with the same IRC
 * host or WebSocket URL. The directory is the reviewed server list of the edition.
 *
 * @param {Object[]} entries toDirectoryEntries()
 * @param {Object} externalServer
 */
function directoryDomainFor(entries, externalServer) {
    const ext = externalServer || {};
    const host = String(ext.host || '').toLowerCase();
    const url = String(ext.websocketUrl || '').trim();
    const entry = (Array.isArray(entries) ? entries : []).find(candidate => (
        ext.connectionType === 'websocket'
            ? url && candidate.websocket_url === url
            : host && String(candidate.host || '').toLowerCase() === host
    ));
    return entry?.domain || '';
}

module.exports = {
    loadEdition,
    loadBundledServerList,
    directoryEntries,
    directoryDomainFor,
    chooseDataDir,
    shellTexts,
    serverListUrl,
    toDirectoryEntries,
    createDiscoveryCache,
    PUBLIC_SERVER_LIST_URL,
};
