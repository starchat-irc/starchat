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

/**
 * Whether the chat page may delete this profile: it must exist. The last one may go too,
 * the apps then show their start (the only way to start over without deleting app data).
 */
function canDeleteConnection(profiles, hash) {
    const list = Array.isArray(profiles) ? profiles : [];
    return list.some(profile => profile.hash === hash);
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
 * A home profile bound to another network than the primary server of this edition, as a
 * connection to that network: server address from the directory entry with that domain.
 * Token and password stay, the binding shows they belong to this network. Null when the
 * directory has no fitting entry.
 *
 * @param {Object} profile home profile with `server`
 * @param {Object[]} directory directory entries (toDirectoryEntries in edition.js)
 */
function homeProfileAsConnection(profile, directory) {
    const domain = String(profile?.server || '').toLowerCase();
    const candidates = (Array.isArray(directory) ? directory : []).filter(entry => String(entry?.domain || '').toLowerCase() === domain);
    const entry = candidates.find(candidate => candidate.host) || candidates[0];
    if (!entry) return null;

    const hasSaslPassword = Boolean(profile.encryptedSaslPassword);
    const externalServer = ConnectionForm.normalizeExternalServer({
        connectionType: entry.host ? 'socket' : 'websocket',
        websocketUrl: entry.host ? '' : String(entry.websocket_url || ''),
        host: String(entry.host || ''),
        port: Number(entry.port) || ConnectionForm.DEFAULT_PORT,
        ssl: entry.ssl !== false,
        // Home profiles keep the nick of the last login in their name ("Default" when unknown)
        nickname: String(profile.nickname || '') || (profile.name !== 'Default' && ConnectionForm.NICK_PATTERN.test(String(profile.name || '')) ? profile.name : ''),
        saslUsername: String(profile.saslUsername || ''),
        defaultChannel: '',
        domain,
    }, { hasSaslPassword });
    delete externalServer.saslPassword;
    // The network domain must fit the server address, otherwise the credentials stay put
    if (externalServer.domain !== domain) return null;
    if (hasSaslPassword) externalServer.encryptedSaslPassword = profile.encryptedSaslPassword;

    const connection = { ...profile, serverType: 'external', externalServer };
    for (const field of ['server', 'nickname', 'saslUsername', 'encryptedSaslPassword', 'authMethod']) delete connection[field];
    return connection;
}

/**
 * Profiles that can work in this edition, and what happens with the others:
 *  - home profiles of the primary server stay; older ones without `server` are bound to it
 *    (trust on first use),
 *  - home profiles of another network become a connection to that network when the
 *    directory knows it (a switch from a branded app to StarChat or back),
 *  - all other home profiles are parked: kept aside, never used, credentials never read.
 *    A later start of a fitting edition takes them back.
 * So credentials only ever go to the network they were stored for.
 *
 * @param {Object[]} profiles stored profiles
 * @param {string} primaryServer domain, '' when the edition has none
 * @param {{ parked?: Object[], directory?: Object[] }} [options]
 * @return {{ kept: Object[], parked: Object[], bound: number, converted: number, restored: number }}
 */
function usableProfiles(profiles, primaryServer, { parked: parkedBefore = [], directory = [] } = {}) {
    const kept = [];
    const parked = [];
    let bound = 0;
    let converted = 0;
    let restored = 0;
    const active = Array.isArray(profiles) ? profiles.filter(Boolean) : [];
    const activeHashes = new Set(active.map(profile => profile.hash));
    const waiting = (Array.isArray(parkedBefore) ? parkedBefore : []).filter(profile => profile && !activeHashes.has(profile.hash));
    const primary = String(primaryServer || '').toLowerCase();

    for (const [index, profile] of [...active, ...waiting].entries()) {
        const fromParking = index >= active.length;
        const server = String(profile.server || '').toLowerCase();
        let usable = null;
        if (profile.serverType === 'external') {
            usable = profile;
        } else if (primary && (server === primary || !server)) {
            usable = server ? profile : { ...profile, server: primary };
            if (!server) bound++;
        } else if (server) {
            usable = homeProfileAsConnection(profile, directory);
            if (usable) converted++;
        }
        if (usable) {
            kept.push(usable);
            if (fromParking) restored++;
        } else {
            parked.push(profile);
        }
    }
    return { kept, parked, bound, converted, restored };
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
