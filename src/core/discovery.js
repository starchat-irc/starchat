/**
 * Discovery file of a server (https://<domain>/.well-known/starchat.json). It announces
 * the extra services a network offers. Servers without it are plain IRC servers.
 */
import { hostOf, isSameSite } from './servers.js';

export const DISCOVERY_PATH = '/.well-known/starchat.json';
export const DISCOVERY_TIMEOUT_MS = 5000;

export const DISCOVERY_SCHEMA_VERSION = 1;

/** Feature names defined in docs/discovery.md. */
export const DISCOVERY_FEATURES = Object.freeze([
    'profiles', 'friends', 'uploads', 'push', 'voice', 'calls', 'reports',
    'explore', 'chatState', 'alwaysOn', 'events', 'gifs', 'communities', 'spotify',
]);

/** Placeholder in links.channelInvite, replaced by the channel name without "#". */
export const CHANNEL_PLACEHOLDER = '{channel}';
/** Placeholder in links.communityInvite, replaced by the slug of the community. */
export const COMMUNITY_PLACEHOLDER = '{community}';

/** Login methods defined in docs/discovery.md. */
export const DISCOVERY_AUTH_METHODS = Object.freeze(['sasl-plain', 'bearer', 'api-login', 'guest']);

/**
 * @typedef {Object} Discovery
 * @property {string|null} name
 * @property {string|null} websocketUrl
 * @property {string|null} apiBaseUrl
 * @property {string[]} auth Subset of DISCOVERY_AUTH_METHODS.
 * @property {string[]} features
 * @property {{ logo?: string, themeCss?: string }} branding
 * @property {{ register?: string, channelInvite?: string, communityInvite?: string, reportPolicy?: string }} links
 */

/**
 * Where to look for the discovery file. A link in the list only counts if it stays on
 * the server domain.
 *
 * @param {{ domain: string, discovery?: string }} server
 * @return {string}
 */
export function discoveryUrl(server) {
    if (isSameSite(hostOf(server.discovery, 'https:'), server.domain)) {
        return server.discovery;
    }
    return `https://${server.domain}${DISCOVERY_PATH}`;
}

function urlWith(value, protocol) {
    return hostOf(value, protocol) ? value.replace(/\/+$/, '') : null;
}

function knownValues(value, known) {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.filter((item) => known.includes(item)))];
}

/**
 * Keeps only what the client understands. Unknown fields and values are ignored so
 * newer files keep working with older clients. Endpoints may live on other domains
 * (the file itself comes from the server domain), but only over https and wss.
 *
 * @param {Object} data
 * @return {Discovery|null} null for an unknown schema version.
 */
export function normalizeDiscovery(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return null;
    }
    if (data.schemaVersion !== DISCOVERY_SCHEMA_VERSION) {
        return null;
    }
    const apiBaseUrl = urlWith(data.apiBaseUrl, 'https:');
    const branding = {};
    const logo = urlWith(data.branding?.logo, 'https:');
    const themeCss = urlWith(data.branding?.themeCss, 'https:');
    if (logo) {
        branding.logo = logo;
    }
    if (themeCss) {
        branding.themeCss = themeCss;
    }
    const links = {};
    for (const key of ['register', 'reportPolicy']) {
        const url = urlWith(data.links?.[key], 'https:');
        if (url) {
            links[key] = url;
        }
    }
    // Invite templates need their placeholder and must be https once it is filled in
    for (const [key, placeholder] of [['channelInvite', CHANNEL_PLACEHOLDER], ['communityInvite', COMMUNITY_PLACEHOLDER]]) {
        const template = data.links?.[key];
        if (typeof template === 'string' && template.includes(placeholder)
            && hostOf(template.replace(placeholder, 'name'), 'https:')) {
            links[key] = template;
        }
    }

    return {
        name: typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim().slice(0, 60) : null,
        websocketUrl: urlWith(data.websocketUrl, 'wss:'),
        apiBaseUrl,
        // Without a list the network behaves like any IRC server.
        auth: Array.isArray(data.auth) ? knownValues(data.auth, DISCOVERY_AUTH_METHODS) : ['sasl-plain', 'guest'],
        // Features talk to the API, without one there is nothing to switch on.
        features: apiBaseUrl ? knownValues(data.features, DISCOVERY_FEATURES) : [],
        branding,
        links,
    };
}

/**
 * @param {{ domain: string, discovery?: string }} server
 * @param {Object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @return {Promise<Discovery|null>} null if the server has no usable file.
 */
export async function fetchDiscovery(server, { fetch = globalThis.fetch, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const response = await fetch(discoveryUrl(server), {
            headers: { Accept: 'application/json' },
            credentials: 'omit',
            signal: controller?.signal,
        });
        if (!response.ok) {
            return null;
        }
        // Redirects are fine within the domain (e.g. to www), not to another one.
        if (response.url && !isSameSite(hostOf(response.url, 'https:'), server.domain)) {
            return null;
        }
        return normalizeDiscovery(await response.json());
    } catch {
        return null;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
