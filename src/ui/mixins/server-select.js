/**
 * Server Select Mixin
 * Server and start channel in the login dialog ("Advanced settings"). A server from the
 * list or any other domain; without a discovery file the user can give its WebSocket
 * address. The last choice is remembered in this browser.
 */
import { findServer, hostOf } from '../../core/servers.js';

export const OTHER_SERVER = '__other__';
const LOGIN_STORAGE_KEY = 'starchat.login';

/** "#chan", "chan" or "" (no start channel). Returns null for names IRC does not allow. */
export function normalizeChannelName(input) {
    const name = String(input ?? '').trim();
    if (!name) return '';
    const withPrefix = /^[#&]/.test(name) ? name : `#${name}`;
    return /^[#&][^\s,\x07]{1,49}$/.test(withPrefix) ? withPrefix.toLowerCase() : null;
}

/** "irc.example.org" from user input like "https://irc.example.org/". */
export function domainFromInput(input) {
    return String(input ?? '').trim().toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, '');
}

function readLastLogin() {
    try {
        const data = JSON.parse(localStorage.getItem(LOGIN_STORAGE_KEY) || 'null');
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

/**
 * @param {Object} [options]
 * @param {import('../../core/servers.js').ServerEntry[]} [options.servers] Choices, the primary one first.
 * @param {string} [options.primaryServerId]
 * @param {string} [options.defaultChannel] Preset of the start channel field.
 * @param {(server: Object) => Promise<Object>} [options.openServerConnection]
 */
export function serverSelectMixin({ servers = [], primaryServerId = '', defaultChannel = '', openServerConnection = null } = {}) {
    const last = readLastLogin();
    const lastIsListed = servers.some(server => server.id === last.serverId);
    const selectedServerId = last.serverId === OTHER_SERVER || lastIsListed ? last.serverId : primaryServerId;

    return {
        serverOptions: servers,
        selectedServerId,
        customServerDomain: selectedServerId === OTHER_SERVER ? String(last.domain || '') : '',
        customWebsocketUrl: selectedServerId === OTHER_SERVER ? String(last.websocket || '') : '',
        startChannel: typeof last.channel === 'string' ? last.channel : defaultChannel,
        loginNickPreset: typeof last.nick === 'string' ? last.nick : '',
        showAdvancedLogin: false,
        _openServerConnection: openServerConnection,

        serverOptionLabel(server) {
            const languages = (server.languages || []).join(', ');
            return languages ? `${server.name} (${languages})` : server.name;
        },

        /** "ST-City · #starchat" under the collapsed advanced settings. */
        loginSummary() {
            const server = this.selectedServerId === OTHER_SERVER
                ? (domainFromInput(this.customServerDomain) || this.t('login_server_other'))
                : (this.serverOptions.find(entry => entry.id === this.selectedServerId)?.name || this.serverName);
            const channel = normalizeChannelName(this.startChannel);
            return channel ? `${server} · ${channel}` : server;
        },

        /** The chosen server entry. Throws an Error whose message is a translation key. */
        selectedServerEntry() {
            if (this.selectedServerId !== OTHER_SERVER) {
                return this.serverOptions.find(entry => entry.id === this.selectedServerId) || this.connection?.server;
            }
            const server = findServer(domainFromInput(this.customServerDomain), this.serverOptions);
            if (!server) throw new Error('server_invalid_domain');
            const websocket = this.customWebsocketUrl.trim();
            if (!websocket) return server;
            if (!hostOf(websocket, 'wss:')) throw new Error('server_invalid_websocket');
            return { ...server, websocket };
        },

        /**
         * Connection to the chosen server: the current one, or a new one with its own
         * discovery, features, stored preferences and drafts. Messages of another server
         * are dropped.
         */
        async prepareSelectedConnection() {
            const server = this.selectedServerEntry();
            const current = this.connection?.server;
            if (server && current && server.id === current.id && server.websocket === current.websocket) {
                return this.connection;
            }
            if (!server || !this._openServerConnection) throw new Error('server_unreachable');

            this.connection = await this._openServerConnection(server);
            this.serverName = this.connection.name;
            this.switchPreferenceScope(server.id);
            this.switchDraftScope(server.id);
            this.stores.messages.set({});
            this.stores.channelTopics.set({});
            this.activeUsers.clearAll();
            this.unreadMessages = {};
            this.mentionsByChannel = {};
            this.unreadMarkerByChannel = {};
            return this.connection;
        },

        /** Joined first and shown; without a start channel the server window opens. */
        applyStartChannel() {
            const channel = normalizeChannelName(this.startChannel);
            if (channel === null) throw new Error('login_start_channel_invalid');
            this.availableChannels = channel ? [channel] : [];
            this.lobbyChannel = channel;
            if (channel) {
                this.currentChannel = channel;
            } else {
                this.messageManager.ensure('Server');
                this.currentChannel = 'Server';
            }
        },

        rememberLogin() {
            try {
                localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({
                    serverId: this.selectedServerId,
                    domain: this.selectedServerId === OTHER_SERVER ? domainFromInput(this.customServerDomain) : '',
                    websocket: this.selectedServerId === OTHER_SERVER ? this.customWebsocketUrl.trim() : '',
                    channel: this.startChannel.trim(),
                    nick: this.nickname,
                }));
            } catch {
                // storage unavailable: the choice is just not remembered
            }
        },
    };
}
