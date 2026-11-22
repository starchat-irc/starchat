/**
 * Connection profiles of the mobile app: the counterpart of the profile handling in
 * desktop/main.js, built on the same rules (desktop/connections.js,
 * desktop/html/shared/connection.js), so both apps validate and store profiles alike.
 *
 * Stored through the native store (ShellPlugin getStore/setStore). Passwords and tokens
 * are kept encrypted inside the profiles (encryptedToken, encryptedSaslPassword) and are
 * only decrypted for the connection that starts.
 *
 * The chat page is treated as untrusted, like on the desktop: it gets public views of the
 * profiles and its changes are checked here.
 */
import connections from '../../desktop/connections.js';
import ConnectionForm from '../../desktop/html/shared/connection.js';
import desktopEdition from '../../desktop/edition.js';

const { applyConnectionUpdate, canDeleteConnection, createTestLimiter, mayUseCredentials, publicProfile, serverAddress, usableProfiles } = connections;
const { directoryDomainFor, directoryEntries, serverListUrl, toDirectoryEntries } = desktopEdition;

const DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Settings for the chat page of one profile: the standaloneConfig of the desktop app,
 * read by mountOptionsFor() in desktop/chat/profile-options.mjs.
 *
 * @param {Object} profile stored profile
 * @param {{ token?: string, saslPassword?: string, locale?: string, directory?: Object[] }} secrets
 */
export function chatConfig(profile, { token = '', saslPassword = '', locale = '', directory = [] } = {}) {
    const base = { locale, isElectron: true, isMobileApp: true, authenticated: true, profileHash: profile.hash };
    if (profile.serverType === 'external') {
        const ext = profile.externalServer || {};
        return {
            ...base,
            isExternalServer: true,
            connectionType: ext.connectionType || 'socket',
            websocketUrl: ext.websocketUrl || '',
            socketHost: ext.host || null,
            socketPort: ext.port || null,
            socketSsl: ext.ssl !== false,
            nickname: ext.nickname || '',
            password: token,
            authMethod: saslPassword ? (ext.authMethod || 'none') : 'none',
            saslUsername: ext.saslUsername || '',
            saslPassword,
            defaultChannel: ext.defaultChannel || '',
            networkDomain: ext.domain || directoryDomainFor(directory, ext),
            networkName: profile.name || '',
        };
    }
    const sasl = Boolean(profile.saslUsername && saslPassword);
    return {
        ...base,
        isExternalServer: false,
        connectionType: 'websocket',
        nickname: profile.nickname || '',
        password: token,
        authMethod: sasl ? 'sasl_plain' : 'ircv3bearer',
        saslUsername: sasl ? profile.saslUsername : '',
        saslPassword: sasl ? saslPassword : '',
        defaultChannel: '',
    };
}

/** Display name in the connection list: the profile name, the network or the nick. */
export function connectionLabel(profile, homeName = '') {
    if (profile?.serverType !== 'external') return profile?.name || homeName || 'Home';
    return ConnectionForm.networkName(profile);
}

/**
 * A new profile from a directory entry and a nickname, checked like a profile from the
 * connections page.
 *
 * @return {{ ok: true, profiles: Object[], profile: Object } | { ok: false, errors: Object<string, string> }}
 */
export function profileFromDirectory(profiles, entry, nickname) {
    const fields = ConnectionForm.fromCuratedServer(entry);
    return applyConnectionUpdate(profiles, {
        serverType: 'external',
        name: entry?.name || '',
        externalServer: { ...fields, nickname: String(nickname || '').trim() },
    }, { primaryServer: '' });
}

/**
 * @param {Object} options
 * @param {{ get(key: string): Promise<string|null>, set(key: string, value: string|null): Promise<void> }} options.store
 * @param {{ encrypt(value: string): Promise<string>, decrypt(value: string): Promise<string|null> }} options.secrets
 * @param {Object} options.edition generated/edition.json
 * @param {Object} [options.bundledServers] generated/servers.json
 * @param {string} [options.language]
 * @param {(host: Object) => Promise<Object>} [options.testConnection] TCP test of the plugin
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createProfileStore({
    store,
    secrets,
    edition,
    bundledServers = null,
    language = 'en',
    testConnection = async () => ({ ok: false, reason: 'unknown' }),
    fetchImpl = globalThis.fetch,
    now = Date.now,
}) {
    const primaryServer = edition.chat?.primaryServer || '';
    const homeName = edition.chat?.networkName || '';
    const testLimiter = createTestLimiter();
    let profiles = [];
    let directory = [];
    let directorySyncedAt = null;
    let active = '';

    async function readJson(key, fallback) {
        try {
            const value = await store.get(key);
            return value ? JSON.parse(value) : fallback;
        } catch {
            return fallback;
        }
    }

    async function saveProfiles(next) {
        profiles = next;
        await store.set('profiles', JSON.stringify(profiles));
    }

    function find(hash) {
        return profiles.find(profile => profile.hash === hash) || null;
    }

    function list() {
        return profiles.map(profile => publicProfile(profile, homeName));
    }

    async function decrypt(value) {
        if (!value) return '';
        try {
            return (await secrets.decrypt(value)) || '';
        } catch {
            return '';
        }
    }

    async function syncDirectory() {
        const url = serverListUrl(edition);
        if (!url) return { ok: true, servers: [], syncedAt: null };
        try {
            const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const servers = toDirectoryEntries(await response.json(), language);
            // A broken or empty answer never replaces a working directory
            if (!servers.length) throw new Error('the server list is empty or not valid');
            directory = servers;
            directorySyncedAt = new Date(now()).toISOString();
            await store.set('directory', JSON.stringify({ servers, syncedAt: directorySyncedAt }));
            return { ok: true, servers, syncedAt: directorySyncedAt };
        } catch (error) {
            return { ok: false, servers: currentDirectory(), syncedAt: directorySyncedAt, error: String(error?.message || error) };
        }
    }

    function currentDirectory() {
        return directoryEntries(directory, bundledServers, language);
    }

    return {
        get profiles() {
            return profiles;
        },
        get active() {
            return active;
        },
        homeName,

        /** Loads profiles and directory; an edition with a primary server starts with a profile for it. */
        async load() {
            const cached = await readJson('directory', {});
            directory = Array.isArray(cached.servers) ? cached.servers : [];
            directorySyncedAt = cached.syncedAt || null;

            const stored = await readJson('profiles', []);
            const parked = await readJson('parkedProfiles', []);
            const result = usableProfiles(stored, primaryServer, { parked, directory: currentDirectory() });
            profiles = result.kept;
            if (!profiles.length && primaryServer) {
                profiles = [{ ...ConnectionForm.buildHomeProfile(), server: primaryServer }];
            }
            await saveProfiles(profiles);
            await store.set('parkedProfiles', result.parked.length ? JSON.stringify(result.parked) : null);

            const remembered = await store.get('activeProfile');
            active = find(remembered) ? remembered : (profiles[0]?.hash || '');
            return profiles;
        },

        /** Refreshes the server list when it is older than a day. */
        async refreshDirectoryIfOld() {
            const age = directorySyncedAt ? now() - Date.parse(directorySyncedAt) : Infinity;
            if (age > DIRECTORY_MAX_AGE_MS) await syncDirectory();
        },

        directory: currentDirectory,
        syncDirectory,

        async setActive(hash) {
            if (!find(hash)) return false;
            active = hash;
            await store.set('activeProfile', hash);
            return true;
        },

        /** Chat settings for a profile, with its decrypted credentials. */
        async configFor(hash, locale = '') {
            const profile = find(hash);
            if (!profile) return null;
            const allowed = mayUseCredentials(profile, primaryServer);
            const token = allowed ? await decrypt(profile.encryptedToken) : '';
            const saslPassword = allowed ? await decrypt(profile.externalServer?.encryptedSaslPassword || profile.encryptedSaslPassword) : '';
            return chatConfig(profile, { token, saslPassword, locale, directory: currentDirectory() });
        },

        /** API token after a login in the chat ("save-credentials"); null removes it. */
        async setToken(hash, token) {
            const profile = find(hash);
            if (!profile) return;
            const next = { ...profile };
            const value = typeof token === 'string' ? token.trim() : '';
            if (value) next.encryptedToken = await secrets.encrypt(value);
            else delete next.encryptedToken;
            await saveProfiles(profiles.map(entry => (entry.hash === hash ? next : entry)));
        },

        /**
         * A SASL PLAIN login that worked in the chat's login dialog, kept for the next start.
         * Only for other servers: the primary server of the edition logs in with a token.
         */
        async setSaslLogin(hash, account, password) {
            const profile = find(hash);
            const name = String(account || '').trim();
            const secret = typeof password === 'string' ? password.slice(0, 512) : '';
            if (profile?.serverType !== 'external' || !ConnectionForm.NICK_PATTERN.test(name) || !secret) return;
            const ext = profile.externalServer || {};
            if (ext.saslUsername === name && ext.encryptedSaslPassword && await decrypt(ext.encryptedSaslPassword) === secret) return;
            const next = {
                ...profile,
                externalServer: {
                    ...ext,
                    saslUsername: name,
                    encryptedSaslPassword: await secrets.encrypt(secret),
                    authMethod: 'sasl_plain',
                },
            };
            await saveProfiles(profiles.map(entry => (entry.hash === hash ? next : entry)));
        },

        /** Logout in the chat: token, SASL login and nick go, the next start shows the login dialog. */
        async clearLogin(hash) {
            const profile = find(hash);
            if (!profile) return;
            const next = { ...profile };
            delete next.encryptedToken;
            if (next.serverType === 'external') {
                next.externalServer = { ...next.externalServer, saslUsername: '', authMethod: 'none', nickname: '' };
                delete next.externalServer.encryptedSaslPassword;
            }
            await saveProfiles(profiles.map(entry => (entry.hash === hash ? next : entry)));
        },

        /** Name shown for a connection, also in push notifications. */
        label(hash) {
            const profile = find(hash);
            return profile ? connectionLabel(profile, homeName) : '';
        },

        /** Nick seen in the chat: kept for the connection list (update-profile-name). */
        async setNickname(hash, nickname) {
            const profile = find(hash);
            const nick = String(nickname || '').trim();
            if (!profile || !ConnectionForm.NICK_PATTERN.test(nick)) return;
            const next = profile.serverType === 'external'
                ? { ...profile, externalServer: { ...profile.externalServer, nickname: nick } }
                : { ...profile, nickname: nick };
            if (JSON.stringify(next) === JSON.stringify(profile)) return;
            await saveProfiles(profiles.map(entry => (entry.hash === hash ? next : entry)));
        },

        /**
         * First connection from the start screen. Without a nickname the chat opens with its
         * login dialog (account, guest, register link of the network).
         */
        async addFromDirectory(entry, nickname = '') {
            const result = profileFromDirectory(profiles, entry, nickname);
            if (!result.ok) return result;
            await saveProfiles(result.profiles);
            return { ok: true, profile: result.profile };
        },

        async addCustom(externalServer, name = '') {
            const result = applyConnectionUpdate(profiles, { serverType: 'external', name, externalServer }, { primaryServer });
            if (!result.ok) return result;
            await saveProfiles(result.profiles);
            return { ok: true, profile: result.profile };
        },

        /**
         * Requests of the connections page in the chat settings (connections-request).
         * Returns the result for connections-response; 'open' and 'delete' also return what
         * the shell has to do ({ open: hash } or { deleted: hash }).
         */
        async request(action, payload, currentHash) {
            switch (action) {
                case 'list':
                    return { ok: true, profiles: list(), current: currentHash, homeName };
                case 'save': {
                    const result = applyConnectionUpdate(profiles, payload, { primaryServer });
                    if (!result.ok) return { ok: false, errors: result.errors };
                    if (result.saslPassword) {
                        let encrypted;
                        try {
                            encrypted = await secrets.encrypt(result.saslPassword);
                        } catch {
                            return { ok: false, errors: { saslPassword: 'connection_error_encryption' } };
                        }
                        if (result.profile.serverType === 'external') result.profile.externalServer.encryptedSaslPassword = encrypted;
                        else result.profile.encryptedSaslPassword = encrypted;
                    }
                    await saveProfiles(result.profiles);
                    return { ok: true, profile: publicProfile(result.profile, homeName), profiles: list() };
                }
                case 'delete': {
                    const hash = payload?.hash;
                    if (!canDeleteConnection(profiles, hash)) return { ok: false, reason: 'not_allowed' };
                    let remaining = profiles.filter(profile => profile.hash !== hash);
                    // The last one may go too, to start over: the StarChat app shows its start
                    // screen, an edition gets a fresh connection to its network (login dialog)
                    if (!remaining.length && primaryServer) remaining = [{ ...ConnectionForm.buildHomeProfile(), server: primaryServer }];
                    await saveProfiles(remaining);
                    if (!find(active)) {
                        if (profiles.length) {
                            await this.setActive(profiles[0].hash);
                        } else {
                            active = '';
                            await store.set('activeProfile', null);
                        }
                    }
                    return { ok: true, profiles: list(), deleted: hash };
                }
                case 'test': {
                    const refused = testLimiter.tryStart();
                    if (refused) return { ok: false, reason: refused };
                    try {
                        return await testConnection(payload || {});
                    } finally {
                        testLimiter.finish();
                    }
                }
                case 'directory':
                    return { ok: true, servers: currentDirectory(), syncedAt: directorySyncedAt };
                case 'directory-sync':
                    return syncDirectory();
                case 'open':
                    return find(payload?.hash) ? { ok: true, open: payload.hash } : { ok: false, reason: 'unknown' };
                default:
                    return { ok: false, reason: 'unknown_action' };
            }
        },

        /** Whether the stored credentials of a profile still go to the same server. */
        serverAddress(hash) {
            const profile = find(hash);
            return profile ? serverAddress(profile) : '';
        },
    };
}
