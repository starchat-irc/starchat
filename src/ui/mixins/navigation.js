/**
 * Navigation Mixin
 * Handles sidebar mode switching, channel join/part/switch, and DM management.
 */
/** Leaves room for the prefix the server adds, IRC lines end at 512 bytes. */
const JOIN_LINE_MAX_LENGTH = 400;

export function navigationMixin() {
    return {
        /** Channels this session asked to join: only their JOIN switches the view (not one from another device). */
        _requestedJoins: new Set(),

        isDirectMessageChannel(channel) {
            return Boolean(channel) && !channel.startsWith('#') && channel !== 'Server';
        },

        /**
         * The user list is open by default; the header button toggles a remembered preference.
         * On small screens the button opens/closes the user list drawer instead.
         */
        toggleUserList() {
            if (this.isMobileLayout) {
                this.mobileSidebarOpen  = false;
                this.mobileUserListOpen = !this.mobileUserListOpen;
                return;
            }
            this.setUserListOpen(!this.userListOpen);
        },

        setUserListOpen(open) {
            this.userListOpen = Boolean(open);
            try {
                localStorage.setItem('chat.userListOpen', this.userListOpen ? '1' : '0');
            } catch {
                // storage unavailable (private mode): keep the in-memory preference
            }
        },

        setSidebarMode(mode) {
            const prev = this.sidebarMode;
            this.sidebarMode = mode;

            if (mode === 'friends') {
                if (prev === 'channels' && this.currentChannel?.startsWith('#')) {
                    this.lastChannelBeforeDM = this.currentChannel;
                }
                if (this.lastDMBeforeChannel && this.messageManager.privateKeys().includes(this.lastDMBeforeChannel)) {
                    this.selectedFriendName = this.lastDMBeforeChannel;
                    this.switchChannel(this.lastDMBeforeChannel);
                    this.$nextTick(() => this.scrollToBottom());
                } else {
                    this.selectedFriendName = '';
                }
            }

            if (mode === 'uploads') {
                if (prev === 'channels' && this.currentChannel?.startsWith('#')) {
                    this.lastChannelBeforeDM = this.currentChannel;
                }
                this.selectedFriendName = '';
                this.fetchMyUploads?.();
            }

            if (mode === 'channels') {
                if (this.isDirectMessageChannel(this.currentChannel)) {
                    this.lastDMBeforeChannel = this.currentChannel;
                }
                const target = this.lastChannelBeforeDM
                    || this.lobbyChannel
                    || this.sortedChannels[0]
                    || this.availableChannels[0]
                    || this.defaultChannel;
                if (target) {
                    this.switchChannel(target);
                    this.$nextTick(() => this.scrollToBottom());
                    return;
                }
            }

            this.scheduleChatStateSave?.();
        },

        /**
         * Leave friends/uploads view without switching the channel yet.
         */
        enterChannelsMode() {
            if (this.sidebarMode === 'channels') return;
            if (this.isDirectMessageChannel(this.currentChannel)) {
                this.lastDMBeforeChannel = this.currentChannel;
            }
            this.sidebarMode = 'channels';
        },

        /**
         * Join several channels with as few lines as possible. Servers rate-limit per
         * command, so one list is served at once while single JOINs would queue up and
         * hold back everything sent after them, like the history of the visible channel.
         */
        joinChannels(channels) {
            if (!this.isRegistered) return;
            const lines = [];
            channels.forEach((channel) => {
                const current = lines[lines.length - 1];
                if (current && current.length + channel.length + 1 <= JOIN_LINE_MAX_LENGTH) {
                    lines[lines.length - 1] = `${current},${channel}`;
                } else {
                    lines.push(channel);
                }
            });
            lines.forEach(line => this.sendRaw(`JOIN ${line}`));
        },

        joinChannel(channel) {
            if (this.isRegistered) {
                this._requestedJoins.add(String(channel).toLowerCase());
                this.sendRaw(`JOIN ${channel}`);
                this.updateStatus(`Trying to join ${channel}...`);
            }
            this.closeExplore?.();
            this.scheduleChatStateSave?.();
        },

        partChannel(args = []) {
            if (typeof args === 'string') args = [args];
            // /part without a channel leaves the current one, if that is a channel
            const target = args[0] || (this.currentChannel?.startsWith('#') ? this.currentChannel : '');
            if (!target) return;
            const channels = target.split(',').map(ch => {
                const trimmed = ch.trim();
                return (trimmed.startsWith('#') ? trimmed : `#${trimmed}`).toLowerCase();
            });
            const currentWasParted = channels.some(ch => ch.toLowerCase() === this.currentChannel?.toLowerCase());

            channels.forEach(channel => {
                // Leaving the lobby on purpose: it is no longer joined on every connect
                if (channel === this.lobbyChannel?.toLowerCase()) this.rememberLeftLobby(channel, true);
                this.sendRaw(`PART ${channel}`);
                this.updateStatus(`You left ${channel}`);
                this.availableChannels = this.availableChannels.filter(c => c.toLowerCase() !== channel.toLowerCase());
                this.channelManager.clearTopic(channel);
                this.clearDraft(channel);
            });

            if (currentWasParted) this.switchAfterLeavingChannel();
            this.contextMenu.show = false;
            this.saveChatState?.();
        },

        /** The visible channel is gone: show another one, the lobby last. */
        switchAfterLeavingChannel() {
            const remaining = this.availableChannels.filter(ch => ch !== this.lobbyChannel);
            if (remaining.length > 0)                              this.switchChannel(remaining[0]);
            else if (this.availableChannels.includes(this.lobbyChannel)) this.switchChannel(this.lobbyChannel);
            else                                                    this.currentChannel = null;
        },

        /**
         * Left on another device (same account, multiclient): the server sends the PART to
         * every session. Remove the channel here as well, unless this session left it itself.
         */
        forgetPartedChannel(channel) {
            if (!this.availableChannels.some(c => c.toLowerCase() === channel)) return;
            if (channel === this.lobbyChannel?.toLowerCase()) this.rememberLeftLobby?.(channel, true);
            const wasCurrent = this.currentChannel?.toLowerCase() === channel;
            this.availableChannels = this.availableChannels.filter(c => c.toLowerCase() !== channel);
            this.channelManager.clearTopic(channel);
            this.clearDraft(channel);
            if (wasCurrent) this.switchAfterLeavingChannel();
            this.scheduleChatStateSave?.();
        },

        switchChannel(channel) {
            this.contextMenu.show       = false;
            this.friendContextMenu.show = false;

            // Channels are stored lower-case, DMs reuse an existing window regardless of casing
            channel = this.resolveTargetKey(channel);

            // A new DM needs a store entry, otherwise it doesn't show up in the DM list
            if (this.isDirectMessageChannel(channel)) {
                this.messageManager.ensure(channel);
            }

            if (channel === this.currentChannel) {
                this.markCurrentChannelAsRead();
                this.scrollToBottom();
                return;
            }

            if (this.currentChannel) {
                this.saveDraft(this.currentChannel, this.newMessage);
                this.leaveTarget(this.currentChannel);
            }

            if (channel?.startsWith('#'))                         this.lastChannelBeforeDM = channel;
            else if (this.isDirectMessageChannel(channel))        this.lastDMBeforeChannel = channel;

            if (channel.startsWith('#')) this.onChannelShown?.(channel);

            if (channel.startsWith('#') && this.sidebarMode !== 'channels') this.sidebarMode = 'channels';
            else if (this.isDirectMessageChannel(channel) && this.sidebarMode !== 'friends') this.sidebarMode = 'friends';

            // A started reply, an open reaction picker and a search belong to the window that is left
            this.closeMessageSearch?.();
            if (this.replyingTo?.target !== channel) this.replyingTo = null;
            this.closeReactionPicker();
            if (channel === 'Server') this.serverWindowActivity = false;

            this.currentChannel     = channel;
            this.isScrolledUp       = false;
            this.newWhileScrolledUp = 0;
            this.selectedFriendName = channel.startsWith('#') ? '' : channel;
            this.newMessage = this.channelDrafts[channel] || '';
            this.$nextTick(() => this.autoGrowInput(this.$refs.messageInput));

            this.enterTarget(channel);
            this.scheduleChatStateSave?.();

            if (this.isRegistered && channel !== 'Server') {
                this.sendRaw(`WHO ${channel}`);
                this.requestHistoryLatest(channel);
                this.prioritizeHistory(channel); // still waiting in the queue? load it next
            }
            this.scrollToUnreadOrBottom(channel);
            this.$nextTick(() => {
                this.setupMediaPlayers();
                this.setupStickToBottom();
            });
            this.focusMessageInput();
        },

        openFriendsHub() {
            this.leaveTarget(this.currentChannel);
            this.selectedFriendName = '';
            this.currentChannel = '';
        },

        /**
         * Close a DM window. Stays in the friends hub instead of jumping to a channel,
         * and forgets the DM so returning to the hub doesn't reopen it.
         */
        closeDM(user) {
            if (this.currentChannel === user) this.openFriendsHub();
            if (this.lastDMBeforeChannel === user) this.lastDMBeforeChannel = null;

            this.messageManager.remove(user);
            delete this.unreadMessages[user];
            delete this.unreadMarkerByChannel[user];
            this.clearDraft(user);
            delete this._lastRead?.[user];
            this.emitUnreadState();
            this.scheduleChatStateSave?.();
        },
    };
}
