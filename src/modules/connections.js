/**
 * Connections module (client only, desktop and mobile app)
 * The connections page of the settings window: list, create, edit, test and delete the
 * connection profiles of the app.
 *
 * The profiles belong to the app around the chat. The chat only talks to its connections
 * API: it gets public views (no tokens, no passwords, only whether one is set) and sends
 * changes that the app checks. A password entered here goes to the app once and is never
 * shown again.
 *
 * Messages (notifyHost / shellMessages):
 *  -> connections-request { id, action: 'list'|'save'|'delete'|'test'|'directory'|'directory-sync'|'open', payload }
 *  <- connections-response { id, result }   result of 'list' may carry current (hash of this tab) and homeName
 *  <- connections-changed                   profiles changed elsewhere: reload the list
 */
import { SCOPE } from '../ui/settings/registry.js';

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_PORT = 6697;

/** Pending requests by id, outside the component: nothing here needs to be reactive. */
const pendingRequests = new Map();
let requestCounter = 0;

function emptyExternalServer() {
    return {
        connectionType: 'socket',
        websocketUrl: '',
        host: '',
        port: DEFAULT_PORT,
        ssl: true,
        nickname: '',
        saslUsername: '',
        defaultChannel: '',
        domain: '',
    };
}

/** "irc.libera.chat:6697 (TLS)" or the WebSocket URL. */
export function describeServer(server) {
    if (!server) return '';
    if (server.connectionType === 'websocket') return server.websocketUrl || '';
    return server.host ? `${server.host}:${server.port || DEFAULT_PORT}${server.ssl !== false ? ' (TLS)' : ''}` : '';
}

/** Editable copy of a public profile view, or a new one of the given type. */
export function connectionDraft(profile = null, serverType = 'home') {
    if (profile) {
        const draft = JSON.parse(JSON.stringify(profile));
        if (draft.serverType === 'external') draft.externalServer = { ...emptyExternalServer(), ...(draft.externalServer || {}) };
        return draft;
    }
    return serverType === 'external'
        ? { hash: '', name: '', serverType: 'external', hasSaslPassword: false, externalServer: emptyExternalServer() }
        : { hash: '', name: '', serverType: 'home', nickname: '', saslUsername: '', hasSaslPassword: false };
}

/** Fields of a draft sent to the app: only what the user can edit. */
export function connectionPayload(draft, password = '') {
    const payload = { hash: draft.hash || undefined, serverType: draft.serverType, name: draft.name || '' };
    if (draft.serverType === 'external') {
        const server = draft.externalServer || {};
        payload.externalServer = {
            connectionType: server.connectionType === 'websocket' ? 'websocket' : 'socket',
            websocketUrl: server.websocketUrl || '',
            host: server.host || '',
            port: Number(server.port) || DEFAULT_PORT,
            ssl: server.ssl !== false,
            nickname: server.nickname || '',
            saslUsername: server.saslUsername || '',
            defaultChannel: server.defaultChannel || '',
            domain: server.domain || '',
        };
    } else {
        payload.nickname = draft.nickname || '';
        payload.saslUsername = draft.saslUsername || '';
    }
    if (password) payload.saslPassword = password;
    return payload;
}

function emptyPage() {
    return {
        available: false,   // the app answered: the page can be used
        loading: false,
        error: '',
        profiles: [],
        current: '',        // hash of the connection this chat runs in
        homeName: '',       // primary server of the edition
        view: 'list',       // 'list' | 'edit' | 'new' | 'directory'
        draft: null,
        original: '',
        password: '',
        errors: {},
        saving: false,
        saved: false,
        deleteConfirm: false,
        test: { state: 'idle', reason: '', ms: 0 },
        servers: [],
        syncedAt: null,
        syncing: false,
        syncError: false,
    };
}

export function connectionsMixin() {
    return {
        connectionsPage: emptyPage(),

        /** Ask the app; resolves with its result, or { ok: false, reason: 'timeout' }. */
        connectionsRequest(action, payload = {}) {
            if (this.shell !== 'desktop' && this.shell !== 'mobile') return Promise.resolve({ ok: false, reason: 'unavailable' });
            requestCounter += 1;
            const id = `c${Date.now().toString(36)}${requestCounter.toString(36)}`;
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    pendingRequests.delete(id);
                    resolve({ ok: false, reason: 'timeout' });
                }, REQUEST_TIMEOUT_MS);
                pendingRequests.set(id, (result) => {
                    clearTimeout(timer);
                    resolve(result && typeof result === 'object' ? result : { ok: false, reason: 'failed' });
                });
                this.notifyHost('connections-request', { id, action, payload });
            });
        },

        /** Answer of the app to a connections request. */
        handleConnectionsResponse(data) {
            const resolve = pendingRequests.get(data?.id);
            if (!resolve) return;
            pendingRequests.delete(data.id);
            resolve(data.result);
        },

        /** Profiles changed in another tab or window: refresh the list, keep an edit in progress. */
        handleConnectionsChanged() {
            if (!this.connectionsPage.available) return;
            this.loadConnections({ keepView: true });
        },

        async loadConnections({ keepView = false } = {}) {
            const page = this.connectionsPage;
            page.loading = true;
            page.error = '';
            const result = await this.connectionsRequest('list');
            page.loading = false;
            if (!result.ok) {
                page.error = 'connections_error_load';
                return;
            }
            page.available = true;
            page.profiles = Array.isArray(result.profiles) ? result.profiles : [];
            if (typeof result.current === 'string') page.current = result.current;
            if (typeof result.homeName === 'string') page.homeName = result.homeName;
            if (!keepView) {
                this.showConnectionList();
                return;
            }
            // The edited connection was deleted elsewhere
            if (page.view === 'edit' && !page.profiles.some(profile => profile.hash === page.draft?.hash)) this.showConnectionList();
        },

        /** Hash of the connection this chat runs in. */
        currentConnectionHash() {
            return this.connectionsPage.current;
        },

        connectionTitle(profile) {
            if (profile?.name) return profile.name;
            if (profile?.serverType === 'external') return this.t('connections_type_external');
            return this.connectionsPage.homeName || this.t('connections_new_home');
        },

        // Views

        showConnectionList() {
            Object.assign(this.connectionsPage, { view: 'list', draft: null, original: '', password: '', errors: {}, deleteConfirm: false, saved: false });
        },

        editConnection(hash) {
            const profile = this.connectionsPage.profiles.find(entry => entry.hash === hash);
            if (!profile) return;
            this.openConnectionDraft(connectionDraft(profile), 'edit');
        },

        startNewConnection(serverType) {
            this.openConnectionDraft(connectionDraft(null, serverType), 'new');
        },

        startConnectionFromServer(server) {
            const draft = connectionDraft(null, 'external');
            draft.name = server?.name || '';
            draft.externalServer = {
                ...draft.externalServer,
                connectionType: server?.host ? 'socket' : 'websocket',
                websocketUrl: server?.websocket_url || '',
                host: server?.host || '',
                port: Number(server?.port) || DEFAULT_PORT,
                ssl: server?.ssl !== false,
                defaultChannel: server?.default_channel || '',
                domain: server?.domain || '',
            };
            this.openConnectionDraft(draft, 'new');
        },

        openConnectionDraft(draft, view) {
            Object.assign(this.connectionsPage, {
                view,
                draft,
                original: view === 'new' ? '' : JSON.stringify(draft),
                password: '',
                errors: {},
                saved: false,
                deleteConfirm: false,
                test: { state: 'idle', reason: '', ms: 0 },
            });
        },

        async showConnectionDirectory() {
            const page = this.connectionsPage;
            page.view = 'directory';
            if (page.servers.length) return;
            const result = await this.connectionsRequest('directory');
            if (result.ok) {
                page.servers = Array.isArray(result.servers) ? result.servers : [];
                page.syncedAt = result.syncedAt || null;
            }
            if (!page.servers.length) this.syncConnectionDirectory();
        },

        async syncConnectionDirectory() {
            const page = this.connectionsPage;
            page.syncing = true;
            page.syncError = false;
            const result = await this.connectionsRequest('directory-sync');
            page.syncing = false;
            if (Array.isArray(result.servers)) page.servers = result.servers;
            if (result.syncedAt) page.syncedAt = result.syncedAt;
            page.syncError = !result.ok || Boolean(result.error);
        },

        // Editing

        isConnectionDirty() {
            const page = this.connectionsPage;
            return Boolean(page.draft) && (JSON.stringify(page.draft) !== page.original || Boolean(page.password));
        },

        connectionError(field) {
            const key = this.connectionsPage.errors?.[field];
            return key ? this.t(key) : '';
        },

        async saveConnection() {
            const page = this.connectionsPage;
            if (!page.draft || page.saving) return;
            page.saving = true;
            page.errors = {};
            const result = await this.connectionsRequest('save', connectionPayload(page.draft, page.password));
            page.saving = false;

            if (!result.ok) {
                page.errors = result.errors && typeof result.errors === 'object' ? result.errors : { form: 'connections_error_save' };
                return;
            }
            if (Array.isArray(result.profiles)) page.profiles = result.profiles;
            this.openConnectionDraft(connectionDraft(result.profile), 'edit');
            page.saved = true;
            setTimeout(() => { page.saved = false; }, 2500);
        },

        async deleteConnection() {
            const page = this.connectionsPage;
            if (!page.draft?.hash) return;
            if (!page.deleteConfirm) {
                page.deleteConfirm = true;
                return;
            }
            const result = await this.connectionsRequest('delete', { hash: page.draft.hash });
            if (!result.ok) {
                page.errors = { form: 'connections_error_delete' };
                page.deleteConfirm = false;
                return;
            }
            if (Array.isArray(result.profiles)) page.profiles = result.profiles;
            this.showConnectionList();
        },

        async testConnectionDraft() {
            const page = this.connectionsPage;
            const server = page.draft?.externalServer;
            if (!server || page.test.state === 'running') return;
            page.test = { state: 'running', reason: '', ms: 0 };
            const result = await this.connectionsRequest('test', connectionPayload(page.draft).externalServer);
            page.test = result.ok
                ? { state: 'ok', reason: '', ms: Number(result.ms) || 0 }
                : { state: 'error', reason: result.reason || 'unknown', ms: 0 };
        },

        connectionTestMessage() {
            const test = this.connectionsPage.test;
            if (test.state === 'ok') return this.t('connections_test_ok', { ms: test.ms });
            if (test.state !== 'error') return '';
            const key = `connections_test_${test.reason}`;
            const text = this.t(key);
            return text === key ? this.t('connections_test_unknown') : text;
        },

        /** Switch to the tab of a connection (closes the settings of this one). */
        openConnectionTab(hash) {
            this.closeSettings?.();
            this.connectionsRequest('open', { hash });
        },

        describeConnectionServer(server) {
            return describeServer(server);
        },
    };
}

export function registerConnectionsSettings(registry) {
    registry.registerSection({
        id: 'connections',
        label: 'settings_section_connections',
        icon: 'bi-plug',
        order: 70,
        when: env => env.shell === 'desktop' || env.shell === 'mobile',
    });
    registry.registerSetting({
        id: 'connections.page',
        section: 'connections',
        type: 'custom',
        view: 'connections',
        scope: SCOPE.App,
        order: 5,
        label: 'settings_section_connections',
        keywords: ['server', 'profil', 'sasl', 'nickserv', 'verbindung', 'connection', 'libera'],
        when: env => env.connectionsApi,
    });
}

/** @type {import('./index.js').ChatModule} */
export const connectionsModule = {
    name: 'connections',
    mixin: connectionsMixin,
    register: registerConnectionsSettings,
    hooks: {
        settingsSectionOpened(sectionId) {
            if (sectionId === 'connections') this.loadConnections();
        },
        shellMessage(type, data) {
            if (type === 'connections-response') this.handleConnectionsResponse(data);
            else if (type === 'connections-changed') this.handleConnectionsChanged();
        },
    },
};
