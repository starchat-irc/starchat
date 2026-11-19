/**
 * One server the client talks to: its list entry, its discovery data and its own
 * token. Features, API calls and tokens never cross from one connection to another.
 */
import { fetchDiscovery } from './discovery.js';

/**
 * @typedef {Object} Connection
 * @property {string} id
 * @property {import('./servers.js').ServerEntry} server
 * @property {import('./discovery.js').Discovery|null} discovery
 * @property {string} name
 * @property {string|null} websocketUrl
 * @property {{ host: string, port: number, tls: boolean }|null} irc
 * @property {string|null} apiBaseUrl
 * @property {{ register?: string, channelInvite?: string, reportPolicy?: string }} links
 * @property {(name: string) => boolean} hasFeature
 * @property {() => string|null} getToken
 * @property {(token: string|null) => void} setToken
 * @property {(path: string) => string} apiUrl
 * @property {(path: string, init?: RequestInit) => Promise<Response>} api
 */

/**
 * @param {Object} options
 * @param {import('./servers.js').ServerEntry} options.server
 * @param {import('./discovery.js').Discovery|null} [options.discovery]
 * @param {string|null} [options.token]
 * @param {typeof fetch} [options.fetch]
 * @return {Connection}
 */
export function createConnection({ server, discovery = null, token = null, fetch = (...args) => globalThis.fetch(...args) }) {
    let currentToken = token;
    const apiBaseUrl = discovery?.apiBaseUrl ?? null;
    const features = new Set(discovery?.features ?? []);

    /**
     * Only relative paths below the API base, so a path from server data cannot point
     * the token at another host.
     */
    function apiUrl(path) {
        if (!apiBaseUrl) {
            throw new Error(`${server.domain} has no API`);
        }
        if (typeof path !== 'string' || /^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(path)) {
            throw new Error('API path must be relative');
        }
        const base = new URL(`${apiBaseUrl}/`);
        const url = new URL(path.replace(/^\/+/, ''), base);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
            throw new Error('API path must be relative');
        }
        return url.toString();
    }

    return {
        id: server.id,
        server,
        discovery,
        name: discovery?.name || server.name,
        // The operator's file is newer than the list entry.
        websocketUrl: discovery?.websocketUrl || server.websocket || null,
        irc: server.irc ?? null,
        apiBaseUrl,
        /** Pages of the network (register, channelInvite, reportPolicy), see docs/discovery.md. */
        links: discovery?.links ?? {},
        hasFeature: (name) => features.has(name),
        getToken: () => currentToken,
        setToken: (value) => { currentToken = value || null; },
        apiUrl,
        api(path, init = {}) {
            const headers = new Headers(init.headers);
            if (!headers.has('Accept')) {
                headers.set('Accept', 'application/json');
            }
            if (currentToken) {
                headers.set('Authorization', `Bearer ${currentToken}`);
            }
            return fetch(apiUrl(path), { ...init, headers, credentials: 'omit' });
        },
        /** One login for API and IRC, only when the server offers it. */
        supportsTokenLogin: () => Boolean(apiBaseUrl && discovery?.auth?.includes('bearer')),
        /**
         * Exchanges name and password for a token (POST login, docs/discovery.md) and
         * keeps it for API calls. Returns { token, nickname }, or null for wrong
         * credentials. Other failures throw.
         */
        async login(username, password) {
            const response = await this.api('login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            if (response.status === 401 || response.status === 422) {
                return null;
            }
            if (!response.ok) {
                throw new Error(`login failed with HTTP ${response.status}`);
            }
            const data = await response.json();
            if (typeof data?.token !== 'string' || data.token === '') {
                throw new Error('login answer without token');
            }
            currentToken = data.token;
            return { token: data.token, nickname: typeof data.nickname === 'string' ? data.nickname : '' };
        },
    };
}

/**
 * Looks up the discovery file and builds the connection. Without a file the
 * connection is a plain IRC connection.
 *
 * @param {import('./servers.js').ServerEntry} server
 * @param {Object} [options]
 * @param {string|null} [options.token]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @return {Promise<Connection>}
 */
export async function openConnection(server, { token = null, fetch, timeoutMs } = {}) {
    const discovery = await fetchDiscovery(server, { fetch, timeoutMs });
    return createConnection({ server, discovery, token, fetch });
}
