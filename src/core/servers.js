/**
 * Public server list: loaded at runtime from the repository, cached, with the copy
 * shipped in the build as the last fallback.
 */
import bundledList from '../../servers/servers.json';

export const SERVER_LIST_URL = 'https://raw.githubusercontent.com/starchat-irc/starchat/main/servers/servers.json';
export const SERVER_LIST_SCHEMA_VERSION = 1;
export const SERVER_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'starchat.serverList:';
const SERVER_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

/**
 * @typedef {Object} ServerEntry
 * @property {string} id
 * @property {string} name
 * @property {string} domain
 * @property {Object<string, string>} [description]
 * @property {string[]} languages
 * @property {string} [websocket]
 * @property {{ host: string, port: number, tls: boolean }} [irc]
 * @property {string} [discovery]
 */

/**
 * Whether host is the domain itself or one of its subdomains.
 *
 * @param {string} host
 * @param {string} domain
 * @return {boolean}
 */
export function isSameSite(host, domain) {
    if (!host || !domain) {
        return false;
    }
    const h = host.toLowerCase();
    const d = domain.toLowerCase();
    return h === d || h.endsWith(`.${d}`);
}

/**
 * Hostname of an URL with the given protocol, or null.
 *
 * @param {string} value
 * @param {string} protocol e.g. 'https:'
 * @return {string|null}
 */
export function hostOf(value, protocol) {
    if (typeof value !== 'string') {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === protocol ? url.hostname : null;
    } catch {
        return null;
    }
}

/**
 * Checks one entry the way the client needs it. The CI schema check covers the public
 * list, but a custom list URL can serve anything.
 *
 * @param {Object} entry
 * @return {ServerEntry|null}
 */
export function normalizeServer(entry, { allowInsecureWebsocket = false } = {}) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    const { id, name, domain } = entry;
    if (typeof id !== 'string' || !SERVER_ID.test(id)) {
        return null;
    }
    if (typeof name !== 'string' || name.trim() === '') {
        return null;
    }
    if (typeof domain !== 'string' || !DOMAIN.test(domain)) {
        return null;
    }

    const server = {
        id,
        name: name.trim(),
        domain,
        languages: Array.isArray(entry.languages) ? entry.languages.filter((l) => typeof l === 'string') : [],
    };
    if (entry.description && typeof entry.description === 'object') {
        server.description = { ...entry.description };
    }
    if (hostOf(entry.websocket, 'wss:') || (allowInsecureWebsocket && hostOf(entry.websocket, 'ws:'))) {
        server.websocket = entry.websocket;
    }
    const irc = entry.irc;
    if (irc && typeof irc.host === 'string' && irc.host !== '' && Number.isInteger(irc.port) && irc.port > 0 && irc.port < 65536) {
        server.irc = { host: irc.host, port: irc.port, tls: irc.tls !== false };
    }
    // A link to a foreign host could hand out its own API and collect logins for this network.
    if (isSameSite(hostOf(entry.discovery, 'https:'), domain)) {
        server.discovery = entry.discovery;
    }
    if (!server.websocket && !server.irc) {
        return null;
    }
    return server;
}

/**
 * @param {Object} data Parsed servers.json.
 * @return {ServerEntry[]|null} null if the format is unknown.
 */
export function normalizeServerList(data) {
    if (!data || data.schemaVersion !== SERVER_LIST_SCHEMA_VERSION || !Array.isArray(data.servers)) {
        return null;
    }
    const seen = new Set();
    const servers = [];
    for (const entry of data.servers) {
        const server = normalizeServer(entry);
        if (server && !seen.has(server.id)) {
            seen.add(server.id);
            servers.push(server);
        }
    }
    return servers;
}

function defaultStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function readCache(storage, key) {
    try {
        const raw = storage?.getItem(key);
        if (!raw) {
            return null;
        }
        const cached = JSON.parse(raw);
        const servers = normalizeServerList(cached.data);
        return servers ? { servers, savedAt: Number(cached.savedAt) || 0 } : null;
    } catch {
        return null;
    }
}

function writeCache(storage, key, data, savedAt) {
    try {
        storage?.setItem(key, JSON.stringify({ savedAt, data }));
    } catch {
        // Full or blocked storage: the list is fetched again next time.
    }
}

/**
 * Loads the server list. Order: fresh cache, network, stale cache, shipped copy. A
 * custom list falls back to its own stale cache only, never to the public list.
 *
 * @param {Object} [options]
 * @param {'default'|string|false} [options.source] 'default' for the public list, an URL, or false for none.
 * @param {typeof fetch} [options.fetch]
 * @param {Storage|null} [options.storage]
 * @param {() => number} [options.now]
 * @param {number} [options.ttl]
 * @param {Object} [options.bundled] Shipped copy, the repository file by default.
 * @return {Promise<{ servers: ServerEntry[], origin: 'cache'|'network'|'stale'|'bundled'|'none' }>}
 */
export async function loadServerList({
    source = 'default',
    fetch = globalThis.fetch,
    storage = defaultStorage(),
    now = Date.now,
    ttl = SERVER_LIST_CACHE_TTL_MS,
    bundled = bundledList,
} = {}) {
    if (source === false) {
        return { servers: [], origin: 'none' };
    }
    const isDefault = source === 'default';
    const url = isDefault ? SERVER_LIST_URL : source;
    const key = CACHE_KEY_PREFIX + url;
    const cached = readCache(storage, key);

    if (cached && now() - cached.savedAt < ttl) {
        return { servers: cached.servers, origin: 'cache' };
    }

    try {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (response.ok) {
            const data = await response.json();
            const servers = normalizeServerList(data);
            if (servers) {
                writeCache(storage, key, data, now());
                return { servers, origin: 'network' };
            }
        }
    } catch {
        // Offline or blocked: fall through to the copies.
    }

    if (cached) {
        return { servers: cached.servers, origin: 'stale' };
    }
    if (isDefault) {
        return { servers: normalizeServerList(bundled) ?? [], origin: 'bundled' };
    }
    return { servers: [], origin: 'none' };
}

/**
 * Finds the primary server of an edition by id or domain. A domain that is not on the
 * list becomes a bare entry, its endpoints then have to come from discovery.
 *
 * @param {string|ServerEntry} primary
 * @param {ServerEntry[]} servers
 * @return {ServerEntry|null}
 */
export function findServer(primary, servers) {
    if (primary && typeof primary === 'object') {
        // ws:// only when the page or app that mounts the chat asks for it for its own entry,
        // never from a server list
        const options = { allowInsecureWebsocket: primary.allowInsecureWebsocket === true };
        return normalizeServer(primary, options) ?? (DOMAIN.test(primary.domain ?? '') ? bareServer(primary.domain) : null);
    }
    if (typeof primary !== 'string' || primary === '') {
        return null;
    }
    const wanted = primary.toLowerCase();
    const listed = servers.find((s) => s.id === wanted || s.domain === wanted);
    if (listed) {
        return listed;
    }
    return DOMAIN.test(wanted) ? bareServer(wanted) : null;
}

function bareServer(domain) {
    return { id: domain.replace(/[^a-z0-9-]/g, '-').slice(0, 40), name: domain, domain, languages: [] };
}

/**
 * The servers an edition offers: the primary one first, then the rest of the list.
 *
 * @param {Object} options
 * @param {string|ServerEntry} [options.primaryServer]
 * @param {'default'|string|false} [options.serverList]
 * @param {Object} [loadOptions] Passed to loadServerList().
 * @return {Promise<{ primary: ServerEntry|null, servers: ServerEntry[], origin: string }>}
 */
export async function resolveServers({ primaryServer = null, serverList = 'default' } = {}, loadOptions = {}) {
    const { servers, origin } = await loadServerList({ ...loadOptions, source: serverList });
    const primary = findServer(primaryServer, servers);
    if (!primary) {
        return { primary: null, servers, origin };
    }
    return { primary, servers: [primary, ...servers.filter((s) => s.id !== primary.id)], origin };
}
