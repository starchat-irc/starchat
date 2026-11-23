/**
 * The chat component: state and core actions of one connection, assembled from the
 * mixins. Feature modules and edition code add their own mixins (options.mixins).
 */
import { escapeTagValue } from '../core/irc-parser.js';
import { escapeHtml, formatDayLabel, startOfDay } from '../core/formatting.js';
import { MessageManager } from '../core/messages.js';
import { UserManager } from '../core/users.js';
import { ChannelManager } from '../core/channels.js';
import { commands } from '../core/commands.js';
import { connectWebSocket } from '../core/websocket.js';
import { saslBearer, saslPlain } from '../core/irc-protocol.js';
import { botsMixin } from './mixins/bots.js';
import { directMessagesMixin } from './mixins/direct-messages.js';
import { channelManagementMixin } from './mixins/channel-management.js';
import { completionMixin } from './mixins/completion.js';
import { draftsMixin } from './mixins/drafts.js';
import { historyMixin } from './mixins/history.js';
import { inputHistoryMixin } from './mixins/input-history.js';
import { ircHandlerMixin } from './mixins/irc-handler.js';
import { messageActionsMixin, QUICK_REACTIONS } from './mixins/message-actions.js';
import { messageSearchMixin } from './mixins/message-search.js';
import { mobileMixin } from './mixins/mobile.js';
import { navigationMixin } from './mixins/navigation.js';
import { preferencesMixin } from './mixins/preferences.js';
import { serverWindowMixin, SERVER_WINDOW } from './mixins/server-window.js';
import { shortcutsMixin } from './mixins/shortcuts.js';
import { uiMixin } from './mixins/ui.js';
import { userCardMixin } from './mixins/user-card.js';
import { serverSelectMixin } from './mixins/server-select.js';
import { settingsMixin } from './mixins/settings.js';
import { shellMixin } from './mixins/shell.js';
import { unreadMixin } from './mixins/unread.js';
import { channelListMixin } from './mixins/channel-list.js';
import { networkLinksMixin } from './mixins/network-links.js';
import { resolveLayout } from './layout.js';
import { DEFAULT_EMOTES, MIRC_COLORS } from '../core/formatting.js';

/** Outgoing lines that are queued while the connection is down instead of being dropped. */
const QUEUEABLE_COMMAND = /^(@\S+ )?(PRIVMSG|NOTICE|BATCH) /i;
const OUTGOING_QUEUE_LIMIT = 200;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** From this many consecutive join/leave lines on they are collapsed into one row. */
const EVENT_GROUP_MIN = 3;
const EVENT_GROUP_NAMES = 5;

/** Guest nicks get a number, so two guests don't fight over one nick. */
const GUEST_NICK = 'Guest';

/** Failed connects in a row (without ever registering) before the login dialog comes back. */
const CONNECT_ATTEMPTS_BEFORE_GIVING_UP = 3;

const EMOJI_LIST = ['😀', '😂', '😍', '🔥', '💯', '🚀', '💡', '🎉', '👍', '❤️', '😎', '🤖', '😜'];

function readFlag(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value === '1';
    } catch {
        return fallback;
    }
}

/** Join/part/quit lines: the noise that gets collapsed or hidden (not kicks, nick changes, topics). */
function isJoinLeaveEvent(message) {
    return Boolean(message?.isJoinPart) && (message.joinPartType === 'join' || message.joinPartType === 'part');
}

function sameNick(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function throttle(fn, wait) {
    let lastCall = 0;
    return function (...args) {
        const now = Date.now();
        if (now - lastCall >= wait) {
            lastCall = now;
            fn.apply(this, args);
        }
    };
}

export function guestNick() {
    return `${GUEST_NICK}${Math.floor(1000 + Math.random() * 9000)}`;
}

/**
 * @param {Object} options
 * @param {import('../core/connection.js').Connection} options.connection
 * @param {Object<string, import('../core/store.js').StateStore>} options.stores messages, users, channelTopics, channelManagement
 * @param {(key: string, params?: Object) => string} options.t
 * @param {string} [options.nickname] Connect right away with this nick (no login form).
 * @param {string} [options.password] SASL PLAIN password for the nick's account.
 * @param {string} [options.saslAccount] Account name for SASL PLAIN when it differs from the nick.
 * @param {string} [options.defaultChannel] Joined and shown first.
 * @param {string|null} [options.shell] 'desktop' | 'mobile' | null (web)
 * @param {string} [options.storageScope] Key suffix of the stored settings and drafts, the
 *   server id by default. An app with several connections to one server passes its own id.
 * @param {boolean} [options.publishesNowPlaying]
 * @param {string} [options.defaultQuitMessage]
 * @param {string} [options.ctcpVersion] Answer to CTCP VERSION.
 * @param {(type: string, data: Object) => void} [options.notifyHost] Messages for the app around the chat.
 * @param {(listener: (type: string, data: Object) => void) => void} [options.shellMessages] Subscribes
 *   the chat to messages from the app around it (see mixins/shell.js).
 * @param {(value: Object) => Object} [options.rawOf] Unwraps a reactive proxy (Alpine.raw).
 * @param {Array<string|import('../modules/index.js').ChatModule>} [options.modules] Loaded feature
 *   modules (or only their names). Their mixins and hooks become part of the component.
 * @param {Object[]} [options.mixins] Mixins of the edition.
 * @param {Object[]} [options.servers] Servers offered in the login dialog, the primary one first.
 * @param {(server: Object) => Promise<Object>} [options.openServerConnection] Builds the connection to another server.
 * @param {typeof connectWebSocket} [options.connectSocket]
 * @param {Function} [options.nativeSocket] IRC over TCP from the app around the chat, see
 *   nativeSocketConnector() in core/native-socket.js. Used for servers without WebSocket.
 * @param {'auto'|'dark'|'light'} [options.defaultTheme] Theme of the edition until the user picks one.
 * @param {() => Promise<import('./embed.js').BearerLogin|null>} [options.bearer] Token source of the
 *   embedding page (see bearerFromParent). Asked on start and before each reconnect; the token
 *   only goes to the primary server.
 * @param {string|null} [options.pushWorker] URL of the push service worker on the page's origin
 *   (copy of starchat/push-sw.js). Browser push stays off without it.
 * @param {string|null} [options.pushGateway] Base URL of the push gateway of an app build, used
 *   on networks that do not relay to FCM themselves (feature "push").
 * @param {'full'|'headless'|Partial<import('./layout.js').ChatLayout>} [options.layout] Parts of the
 *   chat that are shown, see layout.js.
 */
export function createChatComponent(options) {
    const {
        connection,
        stores,
        t,
        nickname = '',
        password = '',
        saslAccount = '',
        defaultChannel = '',
        shell = null,
        publishesNowPlaying = false,
        defaultQuitMessage = '',
        ctcpVersion = 'StarChat',
        notifyHost = () => {},
        shellMessages = null,
        rawOf = (value) => value,
        modules = [],
        mixins = [],
        servers = [],
        openServerConnection = null,
        connectSocket = connectWebSocket,
        nativeSocket = null,
        defaultTheme = 'auto',
        bearer = null,
        pushWorker = null,
        pushGateway = null,
        storageScope: scopeOption = '',
        layout: layoutOption = null,
    } = options;
    const primaryServer = connection?.server || null;
    const storageScope = String(scopeOption || connection?.server?.id || '');
    const moduleList = modules.map(module => (typeof module === 'string' ? { name: module } : module));
    const loadedModules = new Set(moduleList.map(module => module.name));
    const moduleMixins = moduleList.map(module => module.mixin?.() || {});
    const moduleHooks = moduleList.map(module => module.hooks).filter(Boolean);

    return {
        // State
        t,
        stores,
        connection,
        rawOf,
        shell,
        layout: resolveLayout(layoutOption),
        pushWorker,
        pushGateway,
        publishesNowPlaying,
        nickname,
        newMessage: '',
        availableChannels: defaultChannel ? [defaultChannel.toLowerCase()] : [],
        lobbyChannel: defaultChannel.toLowerCase(),
        currentChannel: defaultChannel.toLowerCase(),
        connectionStatus: '',
        connectionState: 'connecting', // 'connecting' | 'connected' | 'reconnecting'
        reconnectAttempt: 0,
        reconnectDelay: 0,
        unreadMessages: {},
        mentionsByChannel: {},
        isRegistered: false,
        activeUsers: UserManager(stores.users),
        channelManager: ChannelManager(stores.channelTopics),
        messageManager: MessageManager(stores.messages),

        showingUserOptions: false,
        selectedUser: '',
        _userMenuAnchor: null,
        showColorPicker: false,
        showEmojiPicker: false,
        showGifPicker: false,
        userListOpen: readFlag('chat.userListOpen', true),
        hideJoinPart: readFlag('chat.hideJoinPart', false),
        expandedEventGroups: {},
        contextMenu: { show: false, x: 0, y: 0, channel: null },
        friendContextMenu: { show: false, x: 0, y: 0, friendId: null, friendName: '' },

        commandSuggestions: [],
        emoteMap: DEFAULT_EMOTES,
        mircColors: MIRC_COLORS,
        emojiList: EMOJI_LIST,
        showIdentifyPrompt: false,
        identifyPassword: '',
        defaultChannel: defaultChannel.toLowerCase(),
        requestedChannels: [],

        // Login
        isAuthenticated: false,
        loginUsername: nickname,
        loginPassword: password,
        rememberMe: false,
        loginError: '',
        isLoading: false,
        performLogout: false,
        _saslPassword: password,
        _saslAccount: saslAccount,
        _bearer: null,
        _apiLogin: null,
        // Password login from the dialog, handed to the mobile app once SASL worked
        _formSaslLogin: null,
        // Mirrors connection.getToken() for Alpine, which does not see the token change
        hasApiToken: false,

        hasMentions: false,
        mentionCount: 0,
        ctcpVersionString: ctcpVersion,
        quickReactions: QUICK_REACTIONS,

        // Capabilities, set by the protocol handler
        supportsChathistory: false,
        supportsMetadata: false,
        metadataVersion: 0,
        supportsReadMarker: false,
        supportsMultiline: false,
        supportsMessageTags: false,
        supportsRedaction: false,
        supportsEchoMessage: false,
        multilineMaxBytes: 4096,
        multilineMaxLines: 0,
        multilineBatchById: {},
        activeBatches: new Set(),
        isScrolledUp: false,
        newWhileScrolledUp: 0,

        unreadMarkerByChannel: {},
        _markerSinceByChannel: {},
        _outgoingQueue: [],
        _joinedChannels: new Set(),
        _bulkJoining: 0,
        _pendingActiveChannel: null,
        _ownPlaying: '',
        ownAvatarUrl: '',
        avatarUrls: {},
        ownStatus: '',
        userStatuses: {},
        lastChannelBeforeDM: null,
        lastDMBeforeChannel: null,
        sidebarMode: 'channels',
        selectedFriendName: '',
        serverName: connection?.name || '',

        // Answers of feature modules while they are not loaded (the modules replace them)
        userInVoice: () => false,
        // Community shown in the sidebar (communities module), null for Home
        activeCommunityFilter: null,
        // The voice bar asks for calls also when the calls module is not loaded
        voiceCall: null,
        incomingCall: null,
        canReportMessage: () => false,
        canUseProfiles: () => false,
        // Paste, drop and backspace of the input only matter for attachments (uploads module)
        handlePasteUpload() {},
        handleInputDrop() {},
        handleInputBackspace() {},

        // Mixins
        ...historyMixin(),
        ...unreadMixin(),
        ...serverWindowMixin(),
        ...messageActionsMixin(),
        ...botsMixin(),
        ...channelManagementMixin(),
        ...navigationMixin(),
        ...draftsMixin({ storageScope }),
        ...preferencesMixin({ storageScope, defaultQuitMessage }),
        ...ircHandlerMixin(),
        ...uiMixin(),
        ...mobileMixin(),
        ...shortcutsMixin(),
        ...completionMixin(),
        ...inputHistoryMixin(),
        ...messageSearchMixin(),
        ...directMessagesMixin(),
        ...userCardMixin(),
        ...channelListMixin(),
        ...networkLinksMixin(),
        ...settingsMixin({ defaultTheme }),
        ...shellMixin(),
        ...serverSelectMixin({ servers, primaryServerId: connection?.server?.id || '', defaultChannel, openServerConnection, loginScope: scopeOption }),
        ...Object.assign({}, ...moduleMixins),
        ...Object.assign({}, ...mixins),

        // Lifecycle

        init() {
            this.setupMobileLayout();
            window.addEventListener('focus', () => { if (this.sidebarMode === 'channels') this.markCurrentChannelAsRead(); });
            window.addEventListener('storage', (event) => this.handlePreferenceStorageEvent(event));
            document.addEventListener('keydown', (event) => this.handleGlobalKeydown(event));
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) return;
                if (this.sidebarMode === 'channels') this.markCurrentChannelAsRead();
                this.scrollToBottom();
            });
            // Network is back: reconnect now instead of waiting for the backoff
            window.addEventListener('online', () => this.socket?.resume?.());
            // Closing the tab: a clean QUIT instead of "Connection closed"
            window.addEventListener('pagehide', () => {
                this.callModuleHook('pageHide');
                this.socket?.quit?.();
            });
            window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
            this.callModuleHook('init');
            shellMessages?.((type, data) => this.handleShellMessage(type, data || {}));
            // App settings (theme, logging) at start; the desktop app also takes it as "chat is running"
            this.requestShellSettings();
            if (!this.loginUsername) this.loginUsername = this.loginNickPreset;
            this.applyWebTheme();
            if (bearer) this.bearerLogin();
            else if (this.nickname) this.connect();
        },

        /** Server features need both the server's discovery entry and the loaded module. */
        hasFeature(name) {
            return loadedModules.has(name) && Boolean(this.connection?.hasFeature(name));
        },

        /** Optional parts of the client that are not loaded (settings, connections, ...). */
        hasModule(name) {
            return loadedModules.has(name);
        },

        notifyHost(type, data = {}) {
            notifyHost(type, data);
        },

        /** Calls a hook (e.g. settingsSectionOpened) on every module that has it. */
        callModuleHook(name, ...args) {
            moduleHooks.forEach(hooks => hooks[name]?.call(this, ...args));
        },

        // Login

        /** Connect with the nick from the form; a password logs into the account (SASL PLAIN). */
        login() {
            const nick = String(this.loginUsername || '').trim();
            if (!nick) {
                this.loginError = this.t('login_nick_required');
                return;
            }
            this.nickname = nick;
            this._saslPassword = this.loginPassword || '';
            this._saslAccount = '';
            this._formSaslLogin = this._saslPassword ? { account: nick, password: this._saslPassword } : null;
            this._bearer = null;
            this._apiLogin = null;
            return this.connect();
        },

        guestLogin() {
            this.nickname = String(this.loginUsername || '').trim() || guestNick();
            this._saslPassword = '';
            this._formSaslLogin = null;
            this._bearer = null;
            this._apiLogin = null;
            return this.connect();
        },

        /**
         * Login with a token from the embedding page, always on the primary server. Without
         * an answer the login dialog stays for a normal login.
         */
        async bearerLogin() {
            if (!bearer || this.isLoading) return;
            this.isLoading = true;
            try {
                if (!(await this.refreshBearer())) return;
            } finally {
                this.isLoading = false;
            }
            this.selectedServerId = primaryServer?.id || this.selectedServerId;
            this._saslPassword = '';
            this._formSaslLogin = null;
            this._apiLogin = null;
            this.nickname = this._bearer.nickname || this._bearer.account || this.nickname || guestNick();
            return this.connect();
        },

        /** Asks the embedding page for a token; on failure the last one stays. */
        async refreshBearer() {
            try {
                const result = await bearer?.();
                if (result?.token) this._bearer = result;
            } catch (error) {
                console.warn('Token from the embedding page failed:', error);
            }
            if (this.usesBearer()) this.setApiToken(this.connection, this._bearer.token);
            return Boolean(this._bearer);
        },

        /** The token belongs to the primary server and is never sent to another one. */
        usesBearer() {
            const server = this.connection?.server;
            return Boolean(this._bearer && primaryServer && server
                && server.id === primaryServer.id && server.websocket === primaryServer.websocket);
        },

        loginMechanism() {
            if (this.usesBearer()) {
                return saslBearer(() => this._bearer.account || '', () => this._bearer.token, this._bearer.tokenType || 'jwt');
            }
            if (this._apiLogin) {
                return saslBearer(() => '', () => this._apiLogin.token, 'jwt');
            }
            return this._saslPassword ? saslPlain(this._saslAccount || this.nickname, this._saslPassword) : null;
        },

        /** Connect to the server chosen in the login dialog and join the start channel. */
        async connect() {
            if (this.isLoading) return;
            this.isLoading = true;
            this.loginError = '';
            try {
                const connection = await this.prepareSelectedConnection();
                if (!connection.websocketUrl && !(nativeSocket && connection.irc)) throw new Error('server_no_websocket');
                this.applyStartChannel();
                await this.prepareToken(connection);
                this.saveShellLogin();
            } catch (error) {
                this.loginError = this.t(error.message);
                return;
            } finally {
                this.isLoading = false;
            }

            this.rememberLogin();
            this.isAuthenticated = true;
            this.performLogout = false;
            this._registeredOnce = false;
            this._failedConnects = 0;
            this.restoreCurrentDraft();
            // Without WebSocket, an app that can open sockets connects over TCP
            const overTcp = !this.connection.websocketUrl && nativeSocket && this.connection.irc;
            this.socket = (overTcp ? nativeSocket : connectSocket)({
                url: this.connection.websocketUrl,
                irc: this.connection.irc,
                nickname: this.nickname,
                sasl: this.loginMechanism(),
                beforeReconnect: this.usesBearer() && bearer ? () => this.refreshBearer() : undefined,
                ctx: this,
                onMessage: this.handleMessage.bind(this),
                onStatusUpdate: (status) => this.handleSocketStatus(status),
                quitMessage: this.effectiveQuitMessage(),
            });
            this.callModuleHook('connecting');
            this.$nextTick(() => {
                this.setupMediaPlayers();
                this.setupStickToBottom();
            });
        },

        /**
         * Apps: a password login got an API token. The app stores it (encrypted; the desktop
         * app only with "remember me") and starts the next session with it instead of the password.
         */
        saveShellLogin() {
            if (!['desktop', 'mobile'].includes(this.shell) || !this._apiLogin?.token) return;
            this.notifyHost('save-credentials', { token: this._apiLogin.token, remember: Boolean(this.rememberMe) });
        },

        /**
         * Mobile app: a password from the login dialog worked over SASL PLAIN (the server has
         * no token login). Sent once the server let us in, so a wrong password is never kept.
         * On the desktop the connections page sets up SASL instead.
         */
        saveShellSaslLogin() {
            const login = this._formSaslLogin;
            this._formSaslLogin = null;
            if (this.shell !== 'mobile' || !login || this._apiLogin || this.usesBearer()) return;
            this.notifyHost('save-credentials', { saslAccount: login.account, saslPassword: login.password });
        },

        setApiToken(connection, token) {
            connection.setToken(token);
            this.hasApiToken = Boolean(token);
        },

        /**
         * Token for the API (and IRC) of this connection: from the embedding page, or from
         * the server's login when it offers one. A failed API login falls back to SASL PLAIN.
         */
        async prepareToken(connection) {
            if (this.usesBearer()) {
                this.setApiToken(connection, this._bearer.token);
                return;
            }
            this.setApiToken(connection, null);
            this._apiLogin = null;
            if (!this._saslPassword || !connection.supportsTokenLogin?.()) return;
            let result;
            try {
                result = await connection.login(this._saslAccount || this.nickname, this._saslPassword);
            } catch (error) {
                console.warn('API login failed, using SASL PLAIN:', error);
                return;
            }
            if (!result) throw new Error('login_sasl_failed');
            this._apiLogin = result;
            this.hasApiToken = true;
            if (result.nickname) this.nickname = result.nickname;
        },

        /**
         * A server that never lets us register (wrong address, refuses this page's origin,
         * no WebSocket) would be retried forever. After a few failures the login dialog
         * comes back with a hint instead.
         */
        handleSocketStatus(status) {
            this.updateStatus(status === 'error' ? this.t('connection_error') : '');
            if (status !== 'disconnected' || this._registeredOnce || this.performLogout) return;
            this._failedConnects = (this._failedConnects || 0) + 1;
            if (this._failedConnects < CONNECT_ATTEMPTS_BEFORE_GIVING_UP) return;
            // Not a logout of the user: an app keeps its stored login for the next start
            this.logout({ notify: false });
            this.loginError = this.t('server_unreachable');
        },

        /** @param {{ notify?: boolean }} [options] notify: tell the app around the chat (it forgets a stored login). */
        logout({ notify = true } = {}) {
            this.isAuthenticated = false;
            this.performLogout = true;
            this._outgoingQueue = [];
            if (notify) this.notifyHost('logout');
            // Still connected: modules can tell the server (e.g. WEBPUSH UNREGISTER)
            this.callModuleHook('loggingOut');
            this.socket?.close();
            this.callModuleHook('loggedOut');
        },

        onSaslFailure() {
            this.loginError = this.t('login_sasl_failed');
            this.logout();
            this.notifyHost('sasl-failure');
        },

        /** CAP diagnostics from the protocol handler. */
        onCapabilities({ offered, enabled }) {
            this.offeredCapabilities = offered;
            this.enabledCapabilities = enabled;
        },

        // Core helpers

        canSendChat() {
            return Boolean(this.socket) && this.isRegistered && this.connectionState === 'connected';
        },

        /**
         * Send a raw IRC line. Chat lines (PRIVMSG/NOTICE/BATCH) are queued while the
         * connection is down and sent after the next registration (see flushOutgoingQueue).
         *
         * @return {boolean} true when the line went out immediately
         */
        sendRaw(command) {
            if (QUEUEABLE_COMMAND.test(command) && !this.canSendChat()) {
                if (this._outgoingQueue.length < OUTGOING_QUEUE_LIMIT) this._outgoingQueue.push(command);
                return false;
            }
            if (!this.socket || this.connectionState === 'reconnecting') return false;
            this.socket.send(command);
            return true;
        },

        /** Set what the own user is listening to (empty = nothing). */
        setOwnPlaying(value) {
            const playing = String(value || '').trim();
            this._ownPlaying = playing;
            if (playing) this.activeUsers.setPlaying(this.nickname, playing);
            else this.activeUsers.clearPlaying(this.nickname);
            this.syncOwnPlaying();
        },

        /**
         * Push the own now-playing state to the server. An empty state removes the key,
         * which also clears values left over from a session that ended without clearing it.
         */
        syncOwnPlaying() {
            if (!this.supportsMetadata || !this.canSendChat()) return;
            this.sendRaw(this._ownPlaying ? `METADATA * SET playing :${this._ownPlaying}` : 'METADATA * SET playing');
        },

        /** Publish the own avatar. Re-asserted on every connect, empty removes a stale key. */
        syncOwnAvatar() {
            if (!this.supportsMetadata || !this.canSendChat()) return;
            this.sendRaw(this.ownAvatarUrl ? `METADATA * SET avatar :${this.ownAvatarUrl}` : 'METADATA * SET avatar');
            this.setUserAvatar(this.nickname, this.ownAvatarUrl);
        },

        flushOutgoingQueue() {
            const queue = this._outgoingQueue.splice(0);
            queue.forEach(line => this.socket?.send(line));
            Object.values(this.stores.messages.get() || {}).forEach(bucket => {
                bucket.content.forEach(message => { if (message.pending) message.pending = false; });
            });
        },

        updatePresence() {
            if (this.isRegistered && this.currentChannel?.startsWith('#')) this.sendRaw(`WHO ${this.currentChannel}`);
        },

        updateStatus(text) {
            this.connectionStatus = text;
        },

        setConnectionState(state, attempt = 0, delay = 0) {
            this.connectionState = state;
            this.reconnectAttempt = attempt;
            this.reconnectDelay = Math.round(delay / 1000);
            // The banner counts down to the next attempt instead of showing the full delay throughout
            clearInterval(this._reconnectCountdown);
            this._reconnectCountdown = null;
            if (state === 'reconnecting' && this.reconnectDelay > 0) {
                this._reconnectCountdown = setInterval(() => {
                    if (this.reconnectDelay > 0) this.reconnectDelay--;
                    if (this.reconnectDelay <= 0) {
                        clearInterval(this._reconnectCountdown);
                        this._reconnectCountdown = null;
                    }
                }, 1000);
            }
            if (state === 'reconnecting') this.isRegistered = false;
            if (state === 'connected') this._registeredOnce = true;
            this.notifyHost('connection-state', { state });
        },

        sendPrivateMessage(username) {
            if (!username) return;
            this.sidebarMode = 'friends';
            this.switchChannel(username);
            this.selectedFriendName = this.currentChannel;
            this.showingUserOptions = false;
        },

        toggleIgnoreUser(username) {
            if (this.isIgnored(username)) {
                this.unignoreUser(username);
                this.updateStatus(`${username} has been unignored.`);
            } else {
                this.ignoreUser(username);
                this.updateStatus(`${username} has been ignored.`);
            }
            this.showingUserOptions = false;
        },

        identifyWithNickServ() {
            if (this.identifyPassword) {
                this.sendRaw(`PRIVMSG NickServ :IDENTIFY ${this.identifyPassword}`);
                this.updateStatus('Attempting NickServ identification...');
            }
        },

        toggleIdentifyPrompt() {
            this.showIdentifyPrompt = !this.showIdentifyPrompt;
            if (!this.showIdentifyPrompt) this.identifyPassword = '';
        },

        openChannelContextMenu(channel, event) {
            this.friendContextMenu.show = false;
            const position = this.clampMenuPosition(event.clientX, event.clientY);
            this.contextMenu.show = true;
            this.contextMenu.x = position.x;
            this.contextMenu.y = position.y;
            this.contextMenu.channel = channel;
        },

        handleInput() {
            // No typing notifications for slash commands (IRCv3 spec)
            if (!this.newMessage.startsWith('/') && this.isChatTarget()) {
                this.notifyTyping();
            }
            this.saveDraft(this.currentChannel, this.newMessage);
            this.commandSuggestions = this.newMessage.startsWith('/')
                ? Object.keys(commands).filter(cmd => cmd.startsWith(this.newMessage.slice(1).toLowerCase()))
                : [];
        },

        completeCommand(suggestion) {
            this.newMessage = `/${suggestion} `;
            this.commandSuggestions = [];
            this.$refs.messageInput?.focus();
        },

        notifyTyping: throttle(function () {
            if (this.isRegistered && this.isChatTarget() && this.canUseClientTag('typing')) {
                const isTyping = this.newMessage.length > 0;
                this.sendRaw(`@+typing=${isTyping ? 'active' : 'done'} TAGMSG ${this.currentChannel}`);
                this.activeUsers.setTyping(this.currentChannel, this.nickname, isTyping);
            }
        }, 3000),

        sendTypingDone() {
            if (this.isRegistered && this.isChatTarget() && this.canUseClientTag('typing')) {
                this.sendRaw(`@+typing=done TAGMSG ${this.currentChannel}`);
                this.activeUsers.setTyping(this.currentChannel, this.nickname, false);
            }
        },

        async sendMessage() {
            const trimmed = this.newMessage.trim();
            if (!trimmed && !this.pendingMediaFile) return;
            // Arrow up brings it back (per window, this session only)
            this.recordInputHistory(this.currentChannel, trimmed);

            if (this.pendingMediaFile && this.sendPendingMediaMessage) {
                try {
                    const sent = await this.sendPendingMediaMessage(trimmed);
                    if (sent) { this.newMessage = ''; this.commandSuggestions = []; }
                } finally {
                    this.endMediaUpload?.();
                }
                return;
            }

            if (trimmed.startsWith('/')) {
                const [cmd, ...args] = trimmed.slice(1).split(' ');
                this.newMessage = '';
                this.commandSuggestions = [];
                const handler = commands[cmd.toLowerCase()];
                if (handler) handler(args, this);
                else this.sendServerCommand(trimmed.slice(1));
            } else if (this.isServerWindow()) {
                // The server window has no chat partner: plain input is a raw IRC command
                this.sendServerCommand(trimmed);
            } else {
                this.sendOwnMessage(this.currentChannel, trimmed, { tags: this.activeReplyTag() });
                this.replyingTo = null;
            }
            // Writing in a channel means it has been read: drop the separator.
            delete this.unreadMarkerByChannel[this.currentChannel];

            this.sendTypingDone();
            this.clearDraft(this.currentChannel);
            this.newMessage = '';
            this.commandSuggestions = [];
            this.resetInputHeight();
            this.scrollToBottom();
            this.isScrolledUp = false;
            this.newWhileScrolledUp = 0;
            this.markCurrentChannelAsRead();
        },

        /**
         * Split a string into chunks whose UTF-8 byte length does not exceed
         * maxBytes, never breaking a multi-byte character (or surrogate pair).
         *
         * @return {string[]}
         */
        splitByByteLength(str, maxBytes) {
            const encoder = new TextEncoder();
            if (encoder.encode(str).length <= maxBytes) return [str];
            const chunks = [];
            let current = '';
            let currentBytes = 0;
            for (const char of str) {
                const charBytes = encoder.encode(char).length;
                if (currentBytes + charBytes > maxBytes && current !== '') {
                    chunks.push(current);
                    current = '';
                    currentBytes = 0;
                }
                current += char;
                currentBytes += charBytes;
            }
            if (current !== '') chunks.push(current);
            return chunks;
        },

        /**
         * Send chat text to a target, using the IRCv3 draft/multiline BATCH when the
         * message spans multiple lines or exceeds the per-line byte budget. Without
         * multiline support every line becomes its own PRIVMSG.
         *
         * @return {string[]} the texts the server will echo
         */
        sendChatText(target, text, tags = null) {
            // Headroom for ":nick!user@host PRIVMSG target :" and CR/LF
            const lineByteBudget = 400;

            // Each segment becomes one PRIVMSG; `concat` segments are re-joined without a linefeed.
            const segments = [];
            text.split('\n').forEach((line) => {
                this.splitByByteLength(line, lineByteBudget).forEach((piece, pieceIndex) => {
                    segments.push({ text: piece, concat: pieceIndex > 0 });
                });
            });

            // Client tags (e.g. +draft/reply) go on the first line, or on the BATCH opener.
            const tagPrefix = tags && Object.keys(tags).length
                ? Object.entries(tags).map(([key, value]) => `${key}=${escapeTagValue(value)}`).join(';')
                : '';
            const withTags = (line) => (tagPrefix ? `@${tagPrefix} ${line}` : line);

            if (segments.length <= 1) {
                this.sendRaw(withTags(`PRIVMSG ${target} :${text}`));
                return [text];
            }

            if (!this.supportsMultiline) {
                // Blank lines are skipped: an empty PRIVMSG would show up as a stray message.
                const lines = segments.filter((segment) => segment.text !== '').map((segment) => segment.text);
                lines.forEach((line, index) => this.sendRaw(index === 0 ? withTags(`PRIVMSG ${target} :${line}`) : `PRIVMSG ${target} :${line}`));
                return lines;
            }

            // Chunk into batches respecting max-lines (0 = no server limit).
            const maxLines = this.multilineMaxLines > 0 ? this.multilineMaxLines : segments.length;
            const echoTexts = [];
            for (let start = 0; start < segments.length; start += maxLines) {
                const batch = segments.slice(start, start + maxLines);
                echoTexts.push(batch.map((segment, index) => (index === 0 || segment.concat ? '' : '\n') + segment.text).join(''));
                const ref = `ml${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
                const opener = `BATCH +${ref} draft/multiline ${target}`;
                this.sendRaw(start === 0 ? withTags(opener) : opener);
                batch.forEach((segment, index) => {
                    // The first segment of a fresh batch must never be a concat line.
                    const concat = segment.concat && index > 0;
                    this.sendRaw(`${concat ? `@batch=${ref};draft/multiline-concat` : `@batch=${ref}`} PRIVMSG ${target} :${segment.text}`);
                });
                this.sendRaw(`BATCH -${ref}`);
            }
            return echoTexts;
        },

        /**
         * Send chat text to a channel or DM and show it right away. The local copy gets
         * its msgid when the server echoes it (echo-message).
         *
         * @param {{ isAction?: boolean, tags?: Object|null }} options
         * @return {Object} the stored message
         */
        sendOwnMessage(target, text, { isAction = false, tags = null } = {}) {
            const delivered = this.canSendChat();
            let echoTexts;
            if (isAction) {
                this.sendRaw(`PRIVMSG ${target} :\u0001ACTION ${text}\u0001`);
                echoTexts = [text];
            } else {
                echoTexts = this.sendChatText(target, text, tags);
            }
            const seen = this.ensureSeenMessageBucket(target);
            seen.add(this.getMessageDedupKey(target, this.nickname, text, false, {}));
            seen.add(`${target}|text|${this.nickname}|${text}`);
            const stored = this.messageManager.add(target, {
                user: this.nickname, text,
                isAction, isJoinPart: false,
                replyTo: tags?.['+draft/reply'] || null,
                nickColor: this.getNickColor(this.nickname),
                timestamp: new Date().toLocaleTimeString(),
                _ts: Date.now(), isHistorical: false,
                pending: !delivered,
            });
            // Without echo-message the server never sends it back: the local copy is final.
            if (this.supportsEchoMessage) this.expectEcho(target, echoTexts, stored, isAction);
            return stored;
        },

        resetInputHeight() {
            const el = this.$refs.messageInput;
            if (el && el.tagName === 'TEXTAREA') el.style.height = 'auto';
        },

        /**
         * Grow the input with its text (max. 160px). An empty input keeps its one-line
         * height. A hidden input has no width: measuring there would wrap the text into
         * many lines.
         */
        autoGrowInput(el) {
            if (!el) return;
            el.style.height = 'auto';
            if (!el.value || !el.offsetWidth) return;
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        },

        escapeHtml,

        // Computed

        get showUserList() {
            // On small screens the user list is a drawer that starts closed
            const open = this.isMobileLayout ? this.mobileUserListOpen : this.userListOpen;
            return this.layout.userList && open && this.sidebarMode === 'channels' && Boolean(this.currentChannel?.startsWith('#'));
        },

        get currentMessages() {
            return this.stores.messages.get()[this.currentChannel]?.content || [];
        },

        /**
         * Render model for the message list: visible messages plus day separators,
         * unread separator, grouping of consecutive lines and mention flags.
         */
        get messageRows() {
            const markerId = this.unreadMarkerByChannel[this.currentChannel];
            const labels = { today: this.t('today'), yesterday: this.t('yesterday'), locale: this.t('locale') };
            const rows = [];
            let previous = null;
            if (this.isServerWindow()) return this.serverWindowRows(labels);
            const messages = this.currentMessages.filter(message =>
                !message._hidden && !((this.hideJoinPart || !this.layout.joinPart) && isJoinLeaveEvent(message)));

            for (let index = 0; index < messages.length; index++) {
                const message = messages[index];
                const kind = this.messageKind(message);
                const newDay = !previous || startOfDay(previous._ts) !== startOfDay(message._ts);
                const isMarker = markerId != null && message.id === markerId;

                // Runs of join/leave lines on the same day become one expandable row
                if (isJoinLeaveEvent(message)) {
                    let end = index;
                    while (end + 1 < messages.length
                        && isJoinLeaveEvent(messages[end + 1])
                        && startOfDay(messages[end + 1]._ts) === startOfDay(message._ts)) {
                        end++;
                    }
                    if (end - index + 1 >= EVENT_GROUP_MIN) {
                        const events = messages.slice(index, end + 1);
                        rows.push({
                            key: `events-${message.id}`,
                            message: events[events.length - 1],
                            kind: 'events',
                            events,
                            summary: this.eventGroupSummary(events),
                            expanded: Boolean(this.expandedEventGroups[message.id]),
                            groupId: message.id,
                            grouped: false,
                            dayLabel: newDay ? formatDayLabel(message._ts, labels) : null,
                            showUnreadSeparator: isMarker,
                            isMention: false,
                        });
                        previous = events[events.length - 1];
                        index = end;
                        continue;
                    }
                }
                const grouped = !newDay && !isMarker && kind === 'text' && !message.replyTo
                    && this.messageKind(previous) === 'text'
                    && sameNick(previous.user, message.user)
                    && Boolean(previous.isNotice) === Boolean(message.isNotice)
                    && message._ts - previous._ts < GROUP_WINDOW_MS;

                rows.push({
                    key: message.id,
                    message,
                    kind,
                    grouped,
                    dayLabel: newDay ? formatDayLabel(message._ts, labels) : null,
                    showUnreadSeparator: isMarker,
                    isMention: (kind === 'text' || kind === 'action')
                        && !sameNick(message.user, this.nickname)
                        && this.isHighlightedText(message.text),
                });
                previous = message;
            }
            return rows;
        },

        /** Server window: one row per line, with day separators. */
        serverWindowRows(labels) {
            let previous = null;
            return this.currentMessages.map((message) => {
                const newDay = !previous || startOfDay(previous._ts) !== startOfDay(message._ts);
                previous = message;
                return {
                    key: message.id,
                    message,
                    kind: 'server',
                    grouped: false,
                    dayLabel: newDay ? formatDayLabel(message._ts, labels) : null,
                    showUnreadSeparator: false,
                    isMention: false,
                };
            });
        },

        /** "3 joined, 2 left" plus the first few nicks of a collapsed join/leave run. */
        eventGroupSummary(events) {
            const joined = new Set();
            const left = new Set();
            for (const event of events) {
                (event.joinPartType === 'join' ? joined : left).add(event.user);
            }
            const counts = [
                joined.size ? this.t('events_joined', { count: joined.size }) : null,
                left.size ? this.t('events_left', { count: left.size }) : null,
            ].filter(Boolean).join(' · ');

            const nicks = [...new Set(events.map(event => event.user))];
            const names = nicks.slice(0, EVENT_GROUP_NAMES).join(', ')
                + (nicks.length > EVENT_GROUP_NAMES ? ` +${nicks.length - EVENT_GROUP_NAMES}` : '');
            return { counts, names };
        },

        toggleEventGroup(groupId) {
            if (this.expandedEventGroups[groupId]) delete this.expandedEventGroups[groupId];
            else this.expandedEventGroups[groupId] = true;
        },

        toggleJoinPart() {
            this.hideJoinPart = !this.hideJoinPart;
            try {
                localStorage.setItem('chat.hideJoinPart', this.hideJoinPart ? '1' : '0');
            } catch {
                // storage unavailable (private mode): keep the in-memory preference
            }
        },

        get privateMessageKeys() { return this.messageManager.privateKeys(); },
        get channelTopic() { return this.parseMircFormatting(this.channelManager.getTopic(this.currentChannel)); },
        get reactiveUsers() { return this.stores.users.get(); },

        get unreadDirectMessageCount() {
            return this.privateMessageKeys
                .filter(u => u !== SERVER_WINDOW)
                .reduce((sum, u) => sum + (this.unreadMessages[u] || 0), 0);
        },
        get pendingFriendRequestCount() { return this.incomingFriendRequests?.length || 0; },
        get friendsIndicatorCount() { return this.unreadDirectMessageCount + this.pendingFriendRequestCount; },

        /** Joined channels, the lobby first, then by name. An edition can group them (channelGroups). */
        get homeChannels() {
            const joined = this.availableChannels.filter(ch => ch.startsWith('#'));
            const lobby = this.lobbyChannel;
            const rest = joined.filter(ch => ch !== lobby).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            return [...(lobby && joined.includes(lobby) ? [lobby] : []), ...rest];
        },

        /** Heading of the channel list: the community shown, otherwise the network. */
        sidebarTitle() {
            return this.activeCommunity?.()?.name || this.serverName || this.t('home');
        },

        isHomeChannel(channel) {
            return this.availableChannels.includes(channel);
        },

        /** @return {{ name: string, joined: boolean, groupLabel?: string }[]} */
        get channelListEntries() {
            return this.channelEntries?.() || this.homeChannels.map(name => ({ name, joined: true }));
        },

        get sortedChannels() {
            return this.channelListEntries.filter(entry => entry.joined).map(entry => entry.name);
        },

        get channelsMentionCount() {
            return this.homeChannels.reduce((sum, ch) => sum + (this.mentionsByChannel[ch] || 0), 0);
        },

        get channelsHaveUnread() {
            return this.homeChannels.some(ch => this.hasUnread(ch));
        },

        get filteredServerChannels() {
            const query = (this.exploreSearch || '').toLowerCase().trim();
            let channels = [...(this.serverChannels || [])];
            if (query) {
                channels = channels.filter(ch =>
                    ch.name.toLowerCase().includes(query) || (ch.topic || '').toLowerCase().includes(query));
            }
            return channels.sort((a, b) => (b.users || 0) - (a.users || 0));
        },
    };
}
