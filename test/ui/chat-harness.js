/**
 * A chat component without Alpine and DOM: the IRC mixins on plain stores, with stubs
 * for the UI methods that come with the component itself. Lines sent to the server and
 * messages to the host app are recorded.
 */
import { createPlainStore } from '../../src/core/store.js';
import { MessageManager } from '../../src/core/messages.js';
import { UserManager } from '../../src/core/users.js';
import { ChannelManager } from '../../src/core/channels.js';
import { createTranslator } from '../../src/i18n/index.js';
import { botsMixin } from '../../src/ui/mixins/bots.js';
import { channelManagementMixin, createChannelManagementState } from '../../src/ui/mixins/channel-management.js';
import { displayNamesMixin } from '../../src/ui/mixins/display-names.js';
import { draftsMixin } from '../../src/ui/mixins/drafts.js';
import { historyMixin } from '../../src/ui/mixins/history.js';
import { ircHandlerMixin } from '../../src/ui/mixins/irc-handler.js';
import { messageActionsMixin } from '../../src/ui/mixins/message-actions.js';
import { navigationMixin } from '../../src/ui/mixins/navigation.js';
import { preferencesMixin } from '../../src/ui/mixins/preferences.js';
import { serverWindowMixin } from '../../src/ui/mixins/server-window.js';
import { unreadMixin } from '../../src/ui/mixins/unread.js';

/** Memory localStorage and a visible, focused document. */
export function installBrowserStubs() {
    const items = new Map();
    globalThis.localStorage = {
        getItem: (key) => (items.has(key) ? items.get(key) : null),
        setItem: (key, value) => items.set(key, String(value)),
        removeItem: (key) => items.delete(key),
        clear: () => items.clear(),
    };
    globalThis.document = { hidden: false, hasFocus: () => true, querySelector: () => null };
    globalThis.requestAnimationFrame = (callback) => callback();
    return items;
}

/**
 * @param {Object} [options]
 * @param {string[]} [options.features] Features of the server's discovery file.
 * @param {string} [options.storageScope]
 * @param {Object} [options.state] Extra or overridden component state.
 */
export function createTestChat({ features = [], storageScope = '', state = {} } = {}) {
    const sent = [];
    const hostMessages = [];
    const stores = {
        messages: createPlainStore(),
        users: createPlainStore(),
        channelTopics: createPlainStore(),
        channelManagement: createPlainStore(createChannelManagementState()),
    };

    const chat = Object.assign(
        {},
        historyMixin(),
        unreadMixin(),
        serverWindowMixin(),
        messageActionsMixin(),
        botsMixin(),
        channelManagementMixin(),
        navigationMixin(),
        draftsMixin({ storageScope }),
        preferencesMixin({ storageScope }),
        displayNamesMixin(),
        ircHandlerMixin(),
        {
            stores,
            nickname: 'me',
            isRegistered: false,
            connectionState: 'connecting',
            connectionStatus: '',
            currentChannel: '',
            availableChannels: [],
            lobbyChannel: '',
            sidebarMode: 'channels',
            selectedFriendName: '',
            newMessage: '',
            unreadMessages: {},
            mentionsByChannel: {},
            unreadMarkerByChannel: {},
            _markerSinceByChannel: {},
            hasMentions: false,
            mentionCount: 0,
            activeBatches: new Set(),
            multilineBatchById: {},
            _joinedChannels: new Set(),
            _bulkJoining: 0,
            _pendingActiveChannel: null,
            avatarUrls: {},
            contextMenu: { show: false },
            friendContextMenu: { show: false },
            supportsChathistory: false,
            supportsMetadata: false,
            supportsMessageTags: true,
            supportsReadMarker: false,
            isScrolledUp: false,
            newWhileScrolledUp: 0,
            ctcpVersionString: 'StarChat test',
            publishesNowPlaying: false,
            _ownPlaying: '',
            $refs: {},
            t: createTranslator({ locale: 'en' }),

            hasFeature: (name) => features.includes(name),
            notifyHost: (type, data = {}) => hostMessages.push({ type, ...data }),
            sendRaw(line) {
                sent.push(line);
                return true;
            },
            canSendChat() {
                return this.isRegistered;
            },
            $nextTick(callback) {
                callback?.();
            },
            setConnectionState(value) {
                this.connectionState = value;
            },
            updateStatus(text) {
                this.connectionStatus = text;
            },

            // Component and UI methods (come with the component)
            flushOutgoingQueue() {},
            updatePresence() {},
            syncOwnPlaying() {},
            getNickColor: () => '',
            avatarUrl(nick) {
                return this.avatarUrls[String(nick).toLowerCase()] || '';
            },
            setUserAvatar(nick, url) {
                this.avatarUrls[nick.toLowerCase()] = url;
            },
            renameUserAvatar() {},
            setUserStatus() {},
            scrollToBottom() {},
            notifyMention() {},
            emitUnreadState() {},
            resetMentions() {},
            setupMediaPlayers() {},
            setupStickToBottom() {},
            focusMessageInput() {},
            autoGrowInput() {},
        },
        state,
    );

    chat.messageManager = MessageManager(stores.messages);
    chat.activeUsers = UserManager(stores.users);
    chat.channelManager = ChannelManager(stores.channelTopics);
    Object.defineProperties(chat, {
        privateMessageKeys: { get() { return this.messageManager.privateKeys(); } },
        reactiveUsers: { get() { return stores.users.get(); } },
    });

    /** Feed one raw IRC line, as the connection does. */
    const receive = (line) => chat.handleMessage({ data: line });

    return { chat, sent, hostMessages, stores, receive };
}
