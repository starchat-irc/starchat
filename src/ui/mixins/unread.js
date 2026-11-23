/**
 * Unread Mixin
 * Unread counters, per-channel mention counters, last-read timestamps and the
 * "new messages" separator. All keys are store keys (channels lower-cased).
 */
/** Bundles MARKREAD updates while messages keep arriving in the visible target. */
const READ_MARKER_DELAY_MS = 3000;

function countsAsUnread(message, nickname) {
    return !message._hidden
        && !message.isJoinPart
        && !message.isSystem
        && message.user?.toLowerCase() !== nickname?.toLowerCase();
}

export function unreadMixin() {
    return {

        /**
         * Whether messages arriving for `target` are currently seen by the user.
         */
        isTargetVisible(target) {
            if (!target || target !== this.currentChannel) return false;
            if (this.sidebarMode === 'uploads') return false;
            if (this.sidebarMode === 'friends' && !this.selectedFriendName) return false;
            // App shell: the chat iframe rarely holds the focus (reading and scrolling don't move it),
            // so foreground/background comes from the shell instead of document.hasFocus().
            if (this.shell === 'mobile') return !document.hidden && !this.appInBackground;
            return !document.hidden && document.hasFocus();
        },

        lastReadTs(target) {
            const ts = Date.parse(this._lastRead?.[target] || '');
            return Number.isFinite(ts) ? ts : null;
        },

        /**
         * Store "read up to now" for a target.
         */
        touchLastRead(target) {
            if (!target || target === 'Server') return;
            this._lastRead = this._lastRead || {};
            this._lastRead[target] = new Date().toISOString();
            this.sendReadMarker(target);
        },

        /**
         * Server time of the newest visible message of a target, or null.
         */
        latestMessageTs(target) {
            const messages = this.messageManager.get(target);
            for (let i = messages.length - 1; i >= 0; i--) {
                const ts = messages[i]._ts;
                if (!messages[i]._hidden && Number.isFinite(ts) && ts > 0) return ts;
            }
            return null;
        },

        /**
         * draft/read-marker: tell the server how far the target has been read, so all
         * other sessions of the account (web, desktop, mobile) follow. The newest
         * message's server time is sent instead of the local clock, so clock skew can
         * never mark messages as read that the user has not seen.
         */
        sendReadMarker(target) {
            if (!this.supportsReadMarker || !this.isRegistered || !target || target === 'Server') return;
            const ts = this.latestMessageTs(target);
            if (ts === null) return;
            this._readMarkerSent = this._readMarkerSent || {};
            const key = target.toLowerCase();
            if ((this._readMarkerSent[key] || 0) >= ts) return;
            this._readMarkerSent[key] = ts;
            this.sendRaw(`MARKREAD ${target} timestamp=${new Date(ts).toISOString()}`);
        },

        /**
         * Messages arriving in the visible target are read right away: move the marker,
         * bundled to at most one MARKREAD per target every few seconds.
         */
        scheduleReadMarker(target) {
            if (!this.supportsReadMarker || !target) return;
            this._readMarkerTimers = this._readMarkerTimers || {};
            if (this._readMarkerTimers[target]) return;
            this._readMarkerTimers[target] = setTimeout(() => {
                delete this._readMarkerTimers[target];
                if (this.isTargetVisible(target)) this.touchLastRead(target);
            }, READ_MARKER_DELAY_MS);
        },

        /**
         * MARKREAD from the server: another session (or the stored state after JOIN)
         * moved the read marker. Only ever moves forward.
         *
         * @param {string} target
         * @param {string} value "timestamp=..." or "*" (nothing read yet)
         */
        applyReadMarker(target, value) {
            if (!target || typeof value !== 'string' || !value.startsWith('timestamp=')) return;
            const ts = Date.parse(value.slice('timestamp='.length));
            if (!Number.isFinite(ts)) return;

            const key = this.resolveTargetKey(target);
            this._readMarkerSent = this._readMarkerSent || {};
            this._readMarkerSent[key.toLowerCase()] = Math.max(this._readMarkerSent[key.toLowerCase()] || 0, ts);

            const known = this.lastReadTs(key);
            if (known !== null && known >= ts) {
                // Nothing new, but a counter restored from the saved chat state may be stale
                if (this.unreadMessages[key] > 0 && !this.isTargetVisible(key)) this.recountUnread(key);
                return;
            }
            this._lastRead = this._lastRead || {};
            this._lastRead[key] = new Date(ts).toISOString();

            if (this.isTargetVisible(key)) return;
            this.recountUnread(key);
            if (!Object.values(this.mentionsByChannel).some(count => count > 0)) this.resetMentions();
            this.scheduleChatStateSave?.();
        },

        /**
         * Ask the server for the stored read marker of a target (DMs only, channels get it after JOIN).
         */
        requestReadMarker(target) {
            if (!this.supportsReadMarker || !this.isRegistered || !target || target.startsWith('#') || target === 'Server') return;
            this.sendRaw(`MARKREAD ${target}`);
        },

        /**
         * Recalculate unread + mention counters of a (not visible) target from the
         * message store and its last-read timestamp. Idempotent, so history batches
         * and restored counters can't add up twice.
         */
        recountUnread(target) {
            const lastRead = this.lastReadTs(target);
            if (lastRead === null) return; // never opened, nothing to compare against

            let unread = 0;
            let mentions = 0;
            for (const message of this.messageManager.get(target)) {
                if (message._ts <= lastRead || !countsAsUnread(message, this.nickname)) continue;
                unread++;
                if (target.startsWith('#') && this.isHighlightedText(message.text)) mentions++;
            }
            this.unreadMessages[target] = unread;
            if (target.startsWith('#')) this.mentionsByChannel[target] = mentions;
            this.emitUnreadState();
        },

        /**
         * Put the "new messages" separator before the first message newer than the
         * last-read time the channel had when it was opened.
         */
        placeUnreadMarker(target) {
            const since = this._markerSinceByChannel[target];
            if (since == null) return;
            const first = this.messageManager.get(target)
                .find(message => message._ts > since && countsAsUnread(message, this.nickname));
            if (first) this.unreadMarkerByChannel[target] = first.id;
        },

        /**
         * Called when a target becomes the current one: remember where reading
         * stopped (for the separator) and reset its counters.
         */
        enterTarget(target) {
            const pendingUnread = this.unreadMessages[target] || 0;
            const lastRead = this.lastReadTs(target);
            delete this.unreadMarkerByChannel[target];
            this._markerSinceByChannel[target] = lastRead;
            if (lastRead !== null) {
                this.placeUnreadMarker(target);
            } else if (pendingUnread > 0) {
                // No last-read time yet: mark the oldest of the counted unread messages.
                const candidates = this.messageManager.get(target).filter(message => countsAsUnread(message, this.nickname));
                const first = candidates[Math.max(0, candidates.length - pendingUnread)];
                if (first) this.unreadMarkerByChannel[target] = first.id;
            }

            this.unreadMessages[target] = 0;
            this.mentionsByChannel[target] = 0;
            this.touchLastRead(target);
            this.emitUnreadState();
        },

        /**
         * Called when a target stops being the current one.
         */
        leaveTarget(target) {
            if (!target) return;
            this.touchLastRead(target);
            delete this.unreadMarkerByChannel[target];
            delete this._markerSinceByChannel[target];
        },

        /**
         * The user looks at the current target again (focus, tab switch).
         * Counters reset, the separator stays until the channel is left.
         */
        markCurrentChannelAsRead() {
            const target = this.currentChannel;
            if (!target) return;
            this.touchLastRead(target);
            if (!this.unreadMessages[target] && !this.mentionsByChannel[target]) return;
            this.unreadMessages[target] = 0;
            this.mentionsByChannel[target] = 0;
            this.emitUnreadState();
        },

        /**
         * Scroll to the "new messages" separator if there is one, otherwise to the bottom.
         */
        scrollToUnreadOrBottom(target = this.currentChannel) {
            const markerId = this.unreadMarkerByChannel[target];
            if (markerId == null) {
                this.scrollToBottom();
                return;
            }
            this.$nextTick(() => requestAnimationFrame(() => {
                const chatWindow = this.$refs.chatMessages || document.querySelector('.chat-messages');
                const separator = chatWindow?.querySelector('.unread-separator');
                if (!chatWindow || !separator) {
                    this.scrollToBottom();
                    return;
                }
                chatWindow.scrollTop = Math.max(0, separator.offsetTop - chatWindow.clientHeight / 3);
                this.isScrolledUp = (chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight) > 150;
            }));
        },

        /**
         * Context menu "mark as read" for a target that is not open.
         */
        markTargetRead(target) {
            if (!target) return;
            this.touchLastRead(target);
            this.unreadMessages[target] = 0;
            this.mentionsByChannel[target] = 0;
            this.emitUnreadState();
            this.scheduleChatStateSave?.();
            this.contextMenu.show = false;
        },

        mentionCountFor(target) {
            return this.mentionsByChannel[target] || 0;
        },

        hasUnread(target) {
            return (this.unreadMessages[target] || 0) > 0;
        },
    };
}
