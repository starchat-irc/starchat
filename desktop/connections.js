'use strict';

/**
 * Connection profiles as the chat's settings page sees and edits them.
 *
 * The page runs inside the chat iframe, which renders content from other people (IRC
 * messages, links, avatars). It is treated like any untrusted client:
 *  - it only ever gets a public view of a profile: no tokens, no (encrypted) passwords,
 *    only whether a password is set;
 *  - it sends single, whitelisted fields; everything is validated here with the same
 *    rules as the old manager (html/shared/connection.js) and merged into the stored
 *    profile, so secrets and internal fields can never be overwritten;
 *  - new profiles get their id here, never from the page;
 *  - the connection test is rate limited, so a compromised page cannot scan networks.
 */

const crypto = require('crypto');
const ConnectionForm = require('./html/shared/connection.js');

/** Public view of a profile: safe to hand to the chat page. */
function publicProfile(profile, homeName = '') {
    const isExternal = profile?.serverType === 'external';
    const ext = profile?.externalServer || {};
    const view = {
        hash: String(profile?.hash || ''),
        name: profile?.name || null,
        serverType: isExternal ? 'external' : 'home',
        nickname: isExternal ? '' : String(profile?.nickname || ''),
        saslUsername: isExternal ? '' : String(profile?.saslUsername || ''),
        hasSaslPassword: isExternal ? Boolean(ext.encryptedSaslPassword) : Boolean(profile?.encryptedSaslPassword),
        summary: '',
    };
    if (isExternal) {
        view.externalServer = {
            connectionType: ext.connectionType === 'websocket' ? 'websocket' : 'socket',
            websocketUrl: String(ext.websocketUrl || ''),
            host: String(ext.host || ''),
            port: Number(ext.port) || ConnectionForm.DEFAULT_PORT,
            ssl: ext.ssl !== false,
            nickname: String(ext.nickname || ''),
            saslUsername: String(ext.saslUsername || ''),
            defaultChannel: String(ext.defaultChannel || ''),
            domain: String(ext.domain || ''),
        };
        view.summary = [ext.nickname, ConnectionForm.describeServer(view.externalServer)].filter(Boolean).join(' · ');
    } else {
        view.summary = [homeName, profile?.nickname].filter(Boolean).join(' · ');
    }
    return view;
}

const EXTERNAL_FIELDS = ['connectionType', 'websocketUrl', 'host', 'port', 'ssl', 'nickname', 'saslUsername', 'defaultChannel', 'domain'];

/** Only the editable fields of an external server, with the expected types. */
function pickExternalServer(input) {
    const source = input && typeof input === 'object' ? input : {};
    const picked = {};
    for (const field of EXTERNAL_FIELDS) {
        if (!(field in source)) continue;
        const value = source[field];
        if (field === 'ssl') picked.ssl = value !== false;
        else if (field === 'port') picked.port = Number(value);
        else picked[field] = typeof value === 'string' ? value : String(value ?? '');
    }
    return picked;
}

function cleanName(value) {
    const name = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    return name || null;
}

/**
 * Apply an edit (or a new connection) from the chat page.
 *
 * @param {object[]} profiles stored profiles (not modified)
 * @param {{ hash?: string, serverType?: string, name?: string, nickname?: string, saslUsername?: string,
 *           externalServer?: object, saslPassword?: string }} update
 * @param {{ newHash?: () => string }} options
 * @return {{ ok: true, profiles: object[], profile: object, saslPassword: string }
 *          | { ok: false, errors: Object<string, string> }}
 */
function applyConnectionUpdate(profiles, update, { newHash = () => crypto.randomUUID(), primaryServer = '' } = {}) {
    const list = Array.isArray(profiles) ? profiles : [];
    const input = update && typeof update === 'object' ? update : {};
    const saslPassword = typeof input.saslPassword === 'string' ? input.saslPassword.slice(0, 512) : '';
    const isNew = !input.hash;

    const existing = isNew ? null : list.find(profile => profile.hash === input.hash);
    if (!isNew && !existing) return { ok: false, errors: { hash: 'connection_error_unknown' } };

    const serverType = existing ? (existing.serverType === 'external' ? 'external' : 'home')
        : (input.serverType === 'external' ? 'external' : 'home');

    if (serverType === 'home' && isNew && !primaryServer) return { ok: false, errors: { form: 'connections_error_save' } };

    let profile;
    if (serverType === 'external') {
        let base = existing || ConnectionForm.buildExternalProfile({ externalServer: {} });
        const mergeInput = () => ({ ...ConnectionForm.emptyExternalServer(), ...(base.externalServer || {}), ...pickExternalServer(input.externalServer) });
        let merged = mergeInput();
        // Another server (or TLS off): the stored password and token were meant for the old one
        if (existing && serverAddress({ serverType: 'external', externalServer: merged }) !== serverAddress(existing)) {
            base = withoutCredentials(base);
            merged = mergeInput();
        }
        const hasSaslPassword = Boolean(base.externalServer?.encryptedSaslPassword);
        const errors = ConnectionForm.validateExternalServer(merged, { saslPassword, hasSaslPassword });
        if (Object.keys(errors).length) return { ok: false, errors };

        const normalized = ConnectionForm.normalizeExternalServer(merged, { saslPassword, hasSaslPassword });
        delete normalized.saslPassword;
        if (base.externalServer?.encryptedSaslPassword) normalized.encryptedSaslPassword = base.externalServer.encryptedSaslPassword;
        profile = { ...base, externalServer: normalized };
        profile.name = 'name' in input ? (cleanName(input.name) || normalized.nickname || 'External') : base.name;
    } else {
        const base = existing || ConnectionForm.buildHomeProfile();
        const candidate = {
            ...base,
            nickname: 'nickname' in input ? String(input.nickname ?? '').trim() : String(base.nickname || ''),
            saslUsername: 'saslUsername' in input ? String(input.saslUsername ?? '').trim() : String(base.saslUsername || ''),
        };
        const hasSaslPassword = Boolean(base.encryptedSaslPassword);
        const errors = ConnectionForm.validateHomeProfile(candidate, { saslPassword, hasSaslPassword });
        if (Object.keys(errors).length) return { ok: false, errors };

        candidate.authMethod = candidate.saslUsername && (saslPassword || hasSaslPassword) ? 'sasl_plain' : 'ircv3bearer';
        if ('name' in input) candidate.name = cleanName(input.name);
        profile = candidate;
    }

    if (isNew) {
        profile.hash = newHash();
        profile.serverType = serverType;
        if (serverType === 'home') profile.server = primaryServer;
        return { ok: true, profiles: [...list, profile], profile, saslPassword };
    }
    return { ok: true, profiles: list.map(entry => (entry.hash === profile.hash ? profile : entry)), profile, saslPassword };
}

/** Whether the chat page may delete this profile: it must exist, and one has to remain. */
function canDeleteConnection(profiles, hash) {
    const list = Array.isArray(profiles) ? profiles : [];
    return list.length > 1 && list.some(profile => profile.hash === hash);
}

/**
 * Connection tests from the chat page: one at a time, a pause between two, and only a
 * handful per window: enough for a person, useless for scanning a network.
 */
function createTestLimiter({ minIntervalMs = 2000, windowMs = 10 * 60 * 1000, maxPerWindow = 20, now = () => Date.now() } = {}) {
    let running = false;
    let lastStartedAt = -Infinity;
    let startedTimes = [];

    return {
        /** @return {string|null} null when allowed, otherwise the refusal reason */
        tryStart() {
            const time = now();
            startedTimes = startedTimes.filter(started => time - started < windowMs);
            if (running) return 'busy';
            if (time - lastStartedAt < minIntervalMs || startedTimes.length >= maxPerWindow) return 'rate_limited';
            running = true;
            lastStartedAt = time;
            startedTimes.push(time);
            return null;
        },
        finish() {
            running = false;
        },
    };
}

/**
 * Where a profile sends its credentials: the primary server it is bound to, or the address
 * of its own server including TLS. Stored passwords and tokens only stay valid while this
 * stays the same.
 */
function serverAddress(profile) {
    if (profile?.serverType === 'external') {
        const ext = profile.externalServer || {};
        // The domain decides where the login goes (its discovery file names the API)
        const domain = String(ext.domain || '').toLowerCase();
        return ext.connectionType === 'websocket'
            ? `wss:${String(ext.websocketUrl || '').trim().toLowerCase()}:${domain}`
            : `tcp:${String(ext.host || '').trim().toLowerCase()}:${Number(ext.port) || 0}:${ext.ssl !== false ? 'tls' : 'plain'}:${domain}`;
    }
    return `home:${String(profile?.server || '').toLowerCase()}`;
}

/** Copy without stored passwords and tokens. */
function withoutCredentials(profile) {
    const copy = { ...profile };
    delete copy.encryptedToken;
    delete copy.encryptedSaslPassword;
    if (copy.externalServer) {
        copy.externalServer = { ...copy.externalServer };
        delete copy.externalServer.encryptedSaslPassword;
    }
    return copy;
}

/** The stored passwords and tokens of `from`, on top of `profile`. */
function withCredentialsOf(profile, from) {
    const copy = { ...profile };
    if (from.encryptedToken) copy.encryptedToken = from.encryptedToken;
    if (from.encryptedSaslPassword) copy.encryptedSaslPassword = from.encryptedSaslPassword;
    if (from.externalServer?.encryptedSaslPassword) {
        copy.externalServer = { ...(copy.externalServer || {}), encryptedSaslPassword: from.externalServer.encryptedSaslPassword };
    }
    return copy;
}

/**
 * Whether the credentials of a profile may be used: external profiles carry their own
 * server, home profiles only while they are bound to the edition's primary server.
 */
function mayUseCredentials(profile, primaryServer) {
    if (!profile) return false;
    if (profile.serverType === 'external') return true;
    return Boolean(primaryServer) && String(profile.server || '').toLowerCase() === String(primaryServer).toLowerCase();
}

/**
 * Profiles that can work in this edition. Home profiles belong to the primary server they
 * were created for (`server`). Older ones without it are bound to the current primary
 * server on the first start (trust on first use). Home profiles of another server, or of
 * an edition without a primary server, are dropped together with their credentials, so
 * those never reach a different server.
 *
 * @param {Object[]} profiles
 * @param {string} primaryServer domain, '' when the edition has none
 * @return {{ kept: Object[], dropped: Object[], bound: number }}
 */
function usableProfiles(profiles, primaryServer) {
    const kept = [];
    const dropped = [];
    let bound = 0;
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        if (profile?.serverType === 'external') {
            kept.push(profile);
        } else if (!primaryServer) {
            dropped.push(profile);
        } else if (!profile?.server) {
            kept.push({ ...profile, server: primaryServer });
            bound++;
        } else if (mayUseCredentials(profile, primaryServer)) {
            kept.push(profile);
        } else {
            dropped.push(profile);
        }
    }
    return { kept, dropped, bound };
}

/**
 * Profile list from the shell window (tabs, names, logging) merged with the store. The
 * window never sets credentials or the bound server; credentials of a profile whose
 * server address changed are dropped.
 *
 * @param {Object[]} stored
 * @param {Object[]} incoming
 * @param {string} primaryServer
 */
function mergeShellProfiles(stored, incoming, primaryServer) {
    const existingList = Array.isArray(stored) ? stored : [];
    return (Array.isArray(incoming) ? incoming : []).map((input) => {
        const existing = existingList.find(profile => profile.hash === input?.hash);
        const next = withoutCredentials(input || {});
        delete next.server;
        if (existing) {
            if (next.serverType !== 'external' && existing.serverType !== 'external') next.server = existing.server;
            return serverAddress(next) === serverAddress(existing) ? withCredentialsOf(next, existing) : next;
        }
        if (next.serverType !== 'external' && primaryServer) next.server = primaryServer;
        return next;
    });
}

module.exports = {
    serverAddress,
    mayUseCredentials,
    usableProfiles,
    mergeShellProfiles,
    publicProfile,
    applyConnectionUpdate,
    canDeleteConnection,
    createTestLimiter,
};
