/**
 * Chat state module (feature "chatState")
 * Open DMs, joined channels, the active conversation, read markers and unread counts are
 * saved on the server and restored on the next connect, also on another device. The
 * synced preferences (highlight words, ignore list, ...) travel in the same document:
 * only the keys changed on this device are sent, so a newer value from another device
 * is not overwritten. API: docs/discovery.md.
 */

/** Saves are collected: navigation, reads and new DMs within this time go out as one. */
const SAVE_DELAY_MS = 5000;

/** Don't ask the server for the account settings more often than this (resume, reconnect). */
const SETTINGS_REFRESH_MS = 30 * 1000;

/** Value of each synced preference in a patch; null removes the key on the server. */
const ACCOUNT_SETTING_VALUES = {
    highlight_words: chat => chat.highlightWords,
    ignored_users: chat => chat.ignoredUsers,
    channel_notifications: chat => chat.channelNotifications,
    // '' = default text: removed from the document
    quit_message: chat => chat.quitMessage || null,
    nick_colors: chat => chat.nickColors,
    // none left = removed from the document
    left_lobbies: chat => (chat.leftLobbies.length ? chat.leftLobbies : null),
    autojoin_channels: chat => (chat.autojoinChannels.length ? chat.autojoinChannels : null),
};

export function chatStateMixin() {
    return {
        _chatStateInitialized: false,
        _chatStateSaveTimer: null,
        _lastRead: {},
        /** { settingKey: change counter }: changed on this device, not yet confirmed by the server. */
        _dirtyAccountSettings: {},
        _dirtySettingsCounter: 0,
        _accountSettingsRefreshedAt: 0,

        /** The state belongs to an account, so it needs the feature and a token. */
        canSyncChatState() {
            return this.hasFeature('chatState') && this.hasApiToken;
        },

        syncsWithAccount() {
            return this.canSyncChatState();
        },

        buildChatStatePayload() {
            const openDms = this.privateMessageKeys;
            const lastRead = { ...this._lastRead };
            if (this.isTargetVisible(this.currentChannel) && this.currentChannel?.startsWith('#')) {
                lastRead[this.currentChannel] = new Date().toISOString();
            }
            // Settings only after the document was loaded: a save racing the restore would
            // overwrite the account's values with this device's.
            const settings = this._chatStateInitialized && this.hasChangedAccountSettings()
                ? { settings_patch: this.buildAccountSettingsPatch().patch }
                : {};

            return {
                ...settings,
                open_dms: openDms,
                joined_channels: this.availableChannels.filter(channel => channel.startsWith('#') && channel !== this.lobbyChannel),
                active_channel: this.currentChannel || null,
                sidebar_mode: this.sidebarMode || 'channels',
                last_read: lastRead,
                unread_counts: Object.fromEntries(
                    [...openDms, ...this.availableChannels]
                        .filter(target => (this.unreadMessages[target] || 0) > 0)
                        .map(target => [target, this.unreadMessages[target]]),
                ),
            };
        },

        async saveChatState() {
            clearTimeout(this._chatStateSaveTimer);
            if (!this.canSyncChatState() || !this._chatStateInitialized) return;
            const payload = this.buildChatStatePayload();
            const marks = payload.settings_patch ? this.buildAccountSettingsPatch().marks : null;
            try {
                const response = await this.connection.api('chat-state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                // Unconfirmed changes stay marked and go out with the next save
                if (response.ok && marks) this.confirmAccountSettings(marks);
            } catch (error) {
                console.warn('Could not save the chat state:', error);
            }
        },

        scheduleChatStateSave() {
            if (!this.canSyncChatState()) return;
            clearTimeout(this._chatStateSaveTimer);
            this._chatStateSaveTimer = setTimeout(() => this.saveChatState(), SAVE_DELAY_MS);
        },

        /** Restores the saved state; afterwards it is known whether the user left the lobby. */
        async restoreChatState() {
            try {
                if (this.canSyncChatState() && !this._chatStateInitialized) await this.restoreSavedChatState();
            } finally {
                this.settleLobby?.();
            }
        },

        async fetchChatState() {
            const response = await this.connection.api('chat-state');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        },

        async restoreSavedChatState() {
            let state;
            try {
                state = await this.fetchChatState();
            } catch (error) {
                console.warn('Could not restore the chat state:', error);
                return;
            }

            for (const nick of Array.isArray(state.open_dms) ? state.open_dms : []) {
                if (typeof nick !== 'string' || !nick) continue;
                // An empty, hidden entry opens the DM without a visible line
                if (!this.privateMessageKeys.includes(nick)) {
                    this.messageManager.add(nick, {
                        user: 'System', text: '', isAction: false, isJoinPart: true, timestamp: '', _ts: 0, _hidden: true,
                    });
                }
                if (this.isRegistered && this.supportsChathistory) this.requestHistoryLatest(nick);
                this.requestReadMarker(nick);
            }

            this.restoreJoinedChannels(state.joined_channels);

            // Read times set here already are newer and win
            this._lastRead = { ...(state.last_read || {}), ...this._lastRead };
            this.applyAccountSettings(state.settings);

            for (const [target, count] of Object.entries(state.unread_counts || {})) {
                const key = this.resolveTargetKey(target);
                if (count > 0 && key !== this.currentChannel) this.unreadMessages[key] = count;
            }
            // History that arrived before the state is counted against last_read now
            [...this.availableChannels, ...this.privateMessageKeys]
                .filter(target => target !== this.currentChannel && this.historyReceivedByTarget?.[target])
                .forEach(target => this.recountUnread(target));

            if (this.currentChannel && this._markerSinceByChannel[this.currentChannel] === undefined) {
                this.enterTarget(this.currentChannel);
                this.scrollToUnreadOrBottom(this.currentChannel);
            }
            this.emitUnreadState();
            this.restoreActiveChannel(state.active_channel);
            this._chatStateInitialized = true;
        },

        /**
         * Channels of the last session. Before 001 they are added to the list and joined
         * with it, after 001 (slow API) they are joined right away.
         */
        restoreJoinedChannels(channels) {
            const lobby = String(this.lobbyChannel || '').toLowerCase();
            const toJoin = [];
            for (const channel of Array.isArray(channels) ? channels : []) {
                const name = String(channel).toLowerCase();
                if (!name.startsWith('#') || name === lobby) continue;
                if (this.availableChannels.some(entry => entry.toLowerCase() === name)) continue;
                if (this.isRegistered) {
                    toJoin.push(name);
                } else {
                    this.availableChannels.push(name);
                }
            }
            if (!toJoin.length) return;
            this._bulkJoining = (this._bulkJoining || 0) + toJoin.length;
            this.joinChannels(toJoin);
            this.scheduleBulkJoinTimeout();
        },

        /** Switch to the last active channel once it is joined (irc-handler switches on its JOIN otherwise). */
        restoreActiveChannel(channel) {
            if (typeof channel !== 'string' || !channel.startsWith('#') || this._pendingPushTarget) return;
            const target = channel.toLowerCase();
            this._pendingActiveChannel = target;
            if (this._bulkJoining && !this._joinedChannels.has(target)) return;
            this.$nextTick(() => {
                if (this._pendingActiveChannel !== target) return;
                if (!this.availableChannels.some(entry => entry.toLowerCase() === target)) return;
                this._pendingActiveChannel = null;
                this.switchChannel(target);
            });
        },

        // Account settings

        /** A preference changed on this device: upload it with the next save. */
        markAccountSettingChanged(key) {
            this._dirtySettingsCounter += 1;
            this._dirtyAccountSettings = { ...this._dirtyAccountSettings, [key]: this._dirtySettingsCounter };
            this.scheduleChatStateSave();
        },

        hasChangedAccountSettings() {
            return Object.keys(this._dirtyAccountSettings).length > 0;
        },

        /** @return {{ patch: Object<string, unknown>, marks: Object<string, number> }} */
        buildAccountSettingsPatch() {
            const marks = { ...this._dirtyAccountSettings };
            const patch = Object.fromEntries(
                Object.keys(marks)
                    .filter(key => ACCOUNT_SETTING_VALUES[key])
                    .map(key => [key, ACCOUNT_SETTING_VALUES[key](this)]),
            );
            return { patch, marks };
        },

        /** The server has the changes, unless the same setting changed again meanwhile. */
        confirmAccountSettings(marks) {
            const remaining = { ...this._dirtyAccountSettings };
            for (const [key, mark] of Object.entries(marks || {})) {
                if (remaining[key] === mark) delete remaining[key];
            }
            this._dirtyAccountSettings = remaining;
        },

        /**
         * Adopts the account's settings. An account that never synced (null) keeps this
         * device's values and uploads them instead. Unsaved changes of this device win.
         */
        applyAccountSettings(settings) {
            if (!settings || typeof settings !== 'object') {
                Object.keys(ACCOUNT_SETTING_VALUES)
                    .filter(key => {
                        const value = ACCOUNT_SETTING_VALUES[key](this);
                        return value !== null && (Array.isArray(value) ? value.length : typeof value !== 'object' || Object.keys(value).length);
                    })
                    .forEach(key => this.markAccountSettingChanged(key));
                return;
            }
            const dirty = this._dirtyAccountSettings;
            const {
                highlight_words: words,
                ignored_users: ignored,
                channel_notifications: notifications,
                quit_message: quitMessage,
                nick_colors: nickColors,
                left_lobbies: leftLobbies,
                autojoin_channels: autojoinChannels,
            } = settings;
            const noSync = { sync: false };
            if (!dirty.highlight_words && Array.isArray(words)) this.setHighlightWords(words, noSync);
            if (!dirty.ignored_users && Array.isArray(ignored)) this.setIgnoredUsers(ignored, noSync);
            if (!dirty.channel_notifications && notifications && typeof notifications === 'object') this.setChannelNotifications(notifications, noSync);
            // The account's document is the truth: a missing key means the default
            if (!dirty.quit_message) this.setQuitMessage(typeof quitMessage === 'string' ? quitMessage : '', noSync);
            if (!dirty.nick_colors && nickColors && typeof nickColors === 'object') this.setNickColors(nickColors, noSync);
            if (!dirty.left_lobbies) this.setLeftLobbies(Array.isArray(leftLobbies) ? leftLobbies : [], noSync);
            if (!dirty.autojoin_channels) this.setAutojoinChannels(Array.isArray(autojoinChannels) ? autojoinChannels : [], noSync);
        },

        /** Another device may have changed the settings (reconnect, app back in front). */
        async refreshAccountSettings({ force = false } = {}) {
            if (!this._chatStateInitialized || !this.canSyncChatState()) return;
            const now = Date.now();
            if (!force && now - this._accountSettingsRefreshedAt < SETTINGS_REFRESH_MS) return;
            this._accountSettingsRefreshedAt = now;
            try {
                const state = await this.fetchChatState();
                if (state?.settings) this.applyAccountSettings(state.settings);
            } catch (error) {
                console.warn('Could not refresh the account settings:', error);
            }
        },

        resetChatState() {
            clearTimeout(this._chatStateSaveTimer);
            this._chatStateInitialized = false;
            this._lastRead = {};
            this._dirtyAccountSettings = {};
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const chatStateModule = {
    name: 'chatState',
    mixin: chatStateMixin,
    hooks: {
        /** Right after the socket is opened, so the lobby can wait for the left-lobby list. */
        connecting() {
            this.restoreChatState();
        },
        loggedOut() {
            this.resetChatState();
        },
    },
};
