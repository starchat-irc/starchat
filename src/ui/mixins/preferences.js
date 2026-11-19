/**
 * Preferences Mixin
 * Personal lists of a connection: highlight words, ignored users, notification levels,
 * quit message, nick colours, autojoin channels and lobbies the user left.
 *
 * Stored in localStorage per storage scope (one scope per connection). A feature module
 * can sync them with an account: it implements markAccountSettingChanged(key), which is
 * called whenever the user changes a value here.
 */
import { isHighlighted, normalizeHighlightWords } from '../../core/formatting.js';
import { DEFAULT_QUIT_MESSAGE } from '../../core/websocket.js';

export const IGNORE_LIST_LIMIT = 100;
const NICK_MAX_LENGTH = 64;

export const PREFERENCE_KEYS = {
    highlightWords: 'chat.highlightWords',
    ignoredUsers: 'chat.ignoredUsers',
    channelNotifications: 'chat.channelNotifications',
    quitMessage: 'chat.quitMessage',
    nickColors: 'chat.nickColors',
    leftLobbies: 'chat.leftLobbies',
    autojoinChannels: 'chat.autojoinChannels',
};

/** Channels joined on every connect, in addition to the ones of the last session. */
export const AUTOJOIN_CHANNELS_LIMIT = 50;

/**
 * Lower-case channel names from a list or from user input ("#a, b #c"). A missing "#"
 * is added, invalid names are dropped, at most AUTOJOIN_CHANNELS_LIMIT.
 */
export function normalizeAutojoinChannels(input) {
    const items = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
    const names = items
        .filter(name => typeof name === 'string')
        .map(name => name.trim().replace(/^#+/, '').toLowerCase())
        .filter(name => name && name.length < 100 && /^[\p{L}\p{N}_\-.]+$/u.test(name))
        .map(name => `#${name}`);
    return [...new Set(names)].slice(0, AUTOJOIN_CHANNELS_LIMIT);
}

/** Lobbies the user left on purpose. They are not joined automatically any more. */
export const LEFT_LOBBIES_LIMIT = 20;

/** Lower-case channel names, unique, at most LEFT_LOBBIES_LIMIT. */
export function normalizeLeftLobbies(input) {
    if (!Array.isArray(input)) return [];
    const names = input
        .filter(name => typeof name === 'string' && name.startsWith('#') && name.length <= 100)
        .map(name => name.toLowerCase());
    return [...new Set(names)].slice(0, LEFT_LOBBIES_LIMIT);
}

/**
 * Own colours for nicks (like mIRC/KVIrc), only for the viewer. Stored as hue: the theme
 * keeps choosing lightness, so a chosen colour stays readable in dark and light mode.
 */
export const NICK_COLOR_HUES = [0, 25, 45, 60, 95, 140, 170, 195, 215, 240, 270, 300, 330];
export const NICK_COLORS_LIMIT = 200;

/** { nick (lower case): hue 0-359 }. Unknown or broken entries are dropped. */
export function normalizeNickColors(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const entries = Object.entries(input)
        .map(([nick, hue]) => [String(nick).trim().toLowerCase(), Number(hue)])
        .filter(([nick, hue]) => nick && nick.length <= NICK_MAX_LENGTH && Number.isInteger(hue) && hue >= 0 && hue < 360)
        .slice(0, NICK_COLORS_LIMIT);
    return Object.fromEntries(entries);
}

export const QUIT_MESSAGE_MAX_LENGTH = 200;

/** One line (it becomes the IRC QUIT reason, mIRC colours stay). '' means the default text. */
export function normalizeQuitMessage(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[\r\n\x00]+/g, ' ').trim().slice(0, QUIT_MESSAGE_MAX_LENGTH);
}

/** Notification level of a channel: everything, only mentions, or nothing. */
export const NOTIFY_LEVELS = ['all', 'mentions', 'mute'];
export const CHANNEL_NOTIFICATIONS_LIMIT = 200;

/**
 * Storage key of a connection preference. Without a scope (single connection) the plain key.
 *
 * @param {string} baseKey
 * @param {string} [scope]
 * @return {string}
 */
export function connectionStorageKey(baseKey, scope = '') {
    return scope ? `${baseKey}:${scope}` : baseKey;
}

function readStored(baseKey, scope, fallback, normalize) {
    try {
        const raw = localStorage.getItem(connectionStorageKey(baseKey, scope));
        return normalize(raw === null ? fallback : JSON.parse(raw));
    } catch {
        return normalize(fallback);
    }
}

function writeStored(baseKey, scope, value) {
    try {
        localStorage.setItem(connectionStorageKey(baseKey, scope), JSON.stringify(value));
    } catch {
        // storage unavailable (private mode): keep the in-memory value
    }
}

/**
 * Trimmed, de-duplicated (case-insensitive) nick list.
 *
 * @param {string[]|string} input
 * @return {string[]}
 */
export function normalizeNickList(input) {
    const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
    const seen = new Set();
    const nicks = [];
    for (const entry of raw) {
        const nick = String(entry ?? '').trim().slice(0, NICK_MAX_LENGTH);
        if (!nick || seen.has(nick.toLowerCase())) continue;
        seen.add(nick.toLowerCase());
        nicks.push(nick);
        if (nicks.length === IGNORE_LIST_LIMIT) break;
    }
    return nicks;
}

/**
 * { '#channel': 'mentions'|'mute' }. Channels are lower-cased, the default "all" is
 * not stored, unknown levels are dropped.
 *
 * @param {unknown} input
 * @return {Object<string, string>}
 */
export function normalizeChannelNotifications(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const entries = Object.entries(input)
        .map(([channel, level]) => [String(channel).trim().toLowerCase(), level])
        .filter(([channel, level]) => channel.startsWith('#') && channel.length <= 64
            && NOTIFY_LEVELS.includes(level) && level !== 'all')
        .slice(0, CHANNEL_NOTIFICATIONS_LIMIT);
    return Object.fromEntries(entries);
}

function readStoredQuitMessage(scope) {
    try {
        return normalizeQuitMessage(localStorage.getItem(connectionStorageKey(PREFERENCE_KEYS.quitMessage, scope)) || '');
    } catch {
        return '';
    }
}

/** Every stored preference of a scope, read and normalized. */
export function readStoredPreferences(scope = '') {
    return {
        highlightWords: readStored(PREFERENCE_KEYS.highlightWords, scope, [], normalizeHighlightWords),
        ignoredUsers: readStored(PREFERENCE_KEYS.ignoredUsers, scope, [], normalizeNickList),
        channelNotifications: readStored(PREFERENCE_KEYS.channelNotifications, scope, {}, normalizeChannelNotifications),
        quitMessage: readStoredQuitMessage(scope),
        nickColors: readStored(PREFERENCE_KEYS.nickColors, scope, {}, normalizeNickColors),
        leftLobbies: readStored(PREFERENCE_KEYS.leftLobbies, scope, [], normalizeLeftLobbies),
        autojoinChannels: readStored(PREFERENCE_KEYS.autojoinChannels, scope, [], normalizeAutojoinChannels),
    };
}

/**
 * @param {Object} [options]
 * @param {string} [options.storageScope] Separates the stored values of several connections.
 * @param {string} [options.defaultQuitMessage] Quit message of the embedding app.
 */
export function preferencesMixin({ storageScope = '', defaultQuitMessage = '' } = {}) {
    return {
        storageScope,
        defaultQuitMessage,
        ...readStoredPreferences(storageScope),
        nickColorHues: NICK_COLOR_HUES,

        /** Another connection: read its stored preferences. */
        switchPreferenceScope(scope) {
            this.storageScope = scope;
            Object.assign(this, readStoredPreferences(scope));
        },

        // Highlight words

        /**
         * Whether a message text mentions the user or contains a highlight word.
         */
        isHighlightedText(text) {
            return isHighlighted(text, this.nickname, this.highlightWords);
        },

        /**
         * @param {string[]|string} words
         * @param {{ sync?: boolean }} options
         */
        setHighlightWords(words, { sync = true } = {}) {
            this.highlightWords = normalizeHighlightWords(words);
            writeStored(PREFERENCE_KEYS.highlightWords, this.storageScope, this.highlightWords);
            if (sync) this.markAccountSettingChanged?.('highlight_words');
        },

        addHighlightWords(words) {
            this.setHighlightWords([...this.highlightWords, ...normalizeHighlightWords(words)]);
        },

        removeHighlightWord(word) {
            const needle = String(word ?? '').trim().toLowerCase();
            this.setHighlightWords(this.highlightWords.filter(entry => entry.toLowerCase() !== needle));
        },

        // Ignore list

        isIgnored(nick) {
            const needle = String(nick ?? '').toLowerCase();
            return this.ignoredUsers.some(entry => entry.toLowerCase() === needle);
        },

        setIgnoredUsers(nicks, { sync = true } = {}) {
            this.ignoredUsers = normalizeNickList(nicks);
            writeStored(PREFERENCE_KEYS.ignoredUsers, this.storageScope, this.ignoredUsers);
            this.syncPushFilter?.();
            if (sync) this.markAccountSettingChanged?.('ignored_users');
        },

        ignoreUser(nick) {
            if (!nick || this.isIgnored(nick)) return false;
            this.setIgnoredUsers([...this.ignoredUsers, nick]);
            return true;
        },

        unignoreUser(nick) {
            if (!this.isIgnored(nick)) return false;
            const needle = String(nick).toLowerCase();
            this.setIgnoredUsers(this.ignoredUsers.filter(entry => entry.toLowerCase() !== needle));
            return true;
        },

        // Notifications per channel

        /** "all" | "mentions" | "mute". DMs always notify. */
        channelNotifyLevel(target) {
            if (!target?.startsWith('#')) return 'all';
            return this.channelNotifications[target.toLowerCase()] || 'all';
        },

        setChannelNotifyLevel(channel, level, { sync = true } = {}) {
            if (!channel?.startsWith('#') || !NOTIFY_LEVELS.includes(level)) return;
            const next = { ...this.channelNotifications };
            if (level === 'all') delete next[channel.toLowerCase()];
            else next[channel.toLowerCase()] = level;
            this.setChannelNotifications(next, { sync });
            // A muted channel must not keep its old badges
            if (level === 'mute') this.markTargetRead?.(channel.toLowerCase());
            this.emitUnreadState?.();
            if (this.contextMenu) this.contextMenu.show = false;
        },

        setChannelNotifications(map, { sync = true } = {}) {
            this.channelNotifications = normalizeChannelNotifications(map);
            writeStored(PREFERENCE_KEYS.channelNotifications, this.storageScope, this.channelNotifications);
            this.syncPushFilter?.();
            if (sync) this.markAccountSettingChanged?.('channel_notifications');
        },

        // Quit message

        /** What others see when this connection leaves (logout, closed tab, window or app). */
        effectiveQuitMessage() {
            return this.quitMessage || this.defaultQuitMessage || DEFAULT_QUIT_MESSAGE;
        },

        setQuitMessage(text, { sync = true } = {}) {
            this.quitMessage = normalizeQuitMessage(text);
            try {
                const key = connectionStorageKey(PREFERENCE_KEYS.quitMessage, this.storageScope);
                if (this.quitMessage) localStorage.setItem(key, this.quitMessage);
                else localStorage.removeItem(key);
            } catch {
                // storage unavailable: keep it for this session
            }
            // Native sockets send their QUIT themselves when the app quits
            this.socket?.setQuitMessage?.(this.effectiveQuitMessage());
            if (sync) this.markAccountSettingChanged?.('quit_message');
        },

        // Nick colours

        /** Own hue for a nick, null when it keeps its automatic colour. */
        customNickHue(nick) {
            const hue = this.nickColors[String(nick ?? '').toLowerCase()];
            return Number.isInteger(hue) ? hue : null;
        },

        /** hue = null resets the nick to its automatic colour. */
        setNickColor(nick, hue, { sync = true } = {}) {
            const key = String(nick ?? '').trim().toLowerCase();
            if (!key) return;
            const next = { ...this.nickColors };
            if (hue === null || hue === undefined) delete next[key];
            else next[key] = hue;
            this.setNickColors(next, { sync });
        },

        setNickColors(map, { sync = true } = {}) {
            this.nickColors = normalizeNickColors(map);
            writeStored(PREFERENCE_KEYS.nickColors, this.storageScope, this.nickColors);
            if (sync) this.markAccountSettingChanged?.('nick_colors');
        },

        // Autojoin channels

        setAutojoinChannels(list, { sync = true } = {}) {
            this.autojoinChannels = normalizeAutojoinChannels(list);
            writeStored(PREFERENCE_KEYS.autojoinChannels, this.storageScope, this.autojoinChannels);
            if (sync) this.markAccountSettingChanged?.('autojoin_channels');
        },

        /** Add channels from user input ("#a, b") and join the new ones right away. */
        addAutojoinChannels(input) {
            const added = normalizeAutojoinChannels(input).filter(channel => !this.autojoinChannels.includes(channel));
            this.setAutojoinChannels([...this.autojoinChannels, ...added]);
            this.joinMissingAutojoinChannels?.();
        },

        /** Only removes it from the list. The channel itself stays open. */
        removeAutojoinChannel(channel) {
            const needle = String(channel || '').toLowerCase();
            this.setAutojoinChannels(this.autojoinChannels.filter(entry => entry !== needle));
        },

        // Left lobbies

        /** Whether the user left this lobby on purpose (it is then not joined automatically). */
        hasLeftLobby(channel) {
            return Boolean(channel) && this.leftLobbies.includes(String(channel).toLowerCase());
        },

        setLeftLobbies(list, { sync = true } = {}) {
            this.leftLobbies = normalizeLeftLobbies(list);
            writeStored(PREFERENCE_KEYS.leftLobbies, this.storageScope, this.leftLobbies);
            if (sync) this.markAccountSettingChanged?.('left_lobbies');
        },

        /** Remember (left = true) or forget (joined again) that the user left a lobby. */
        rememberLeftLobby(channel, left) {
            const name = String(channel || '').toLowerCase();
            if (!name || this.hasLeftLobby(name) === left) return;
            this.setLeftLobbies(left ? [...this.leftLobbies, name] : this.leftLobbies.filter(entry => entry !== name));
        },

        // Live sync between tabs

        /**
         * Another tab of the same origin changed a stored preference. Only tabs with the
         * same storage scope (same connection) follow.
         */
        handlePreferenceStorageEvent(event) {
            if (!event?.key) return;
            const changed = Object.entries(PREFERENCE_KEYS)
                .find(([, baseKey]) => event.key === connectionStorageKey(baseKey, this.storageScope));
            if (changed) {
                this[changed[0]] = readStoredPreferences(this.storageScope)[changed[0]];
                return;
            }
            this.applyDevicePreferenceChange?.(event.key, event.newValue);
        },
    };
}
