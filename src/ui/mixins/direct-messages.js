/**
 * Direct Messages Mixin
 * The DM list of the sidebar, latest activity first. With the friends module, DMs with
 * friends get their own section; that module replaces isFriendNick() and isFriendOnline().
 */
export function directMessagesMixin() {
    return {
        isFriendNick() {
            return false;
        },

        isFriendOnline() {
            return false;
        },

        /** Time of the newest message in a conversation (0 when none is loaded yet). */
        lastActivityAt(key) {
            const content = this.stores.messages.get()?.[key]?.content || [];
            for (let index = content.length - 1; index >= 0; index--) {
                const entry = content[index];
                if (!entry._hidden && typeof entry._ts === 'number' && entry._ts > 0) return entry._ts;
            }
            return 0;
        },

        /** Open DMs, latest activity first (ties: alphabetical). */
        sortedDmKeys(keys) {
            return [...keys].sort((a, b) => (this.lastActivityAt(b) - this.lastActivityAt(a)) || a.localeCompare(b));
        },

        /** DMs with friends (empty without the friends module). */
        friendDmKeys() {
            return this.sortedDmKeys(this.privateMessageKeys.filter(key => this.isFriendNick(key)));
        },

        /** DMs with everyone else. */
        otherDmKeys() {
            return this.sortedDmKeys(this.privateMessageKeys.filter(key => !this.isFriendNick(key)));
        },

        openDirectMessage(nick) {
            if (!nick) return;
            this.selectedFriendName = nick;
            this.sendPrivateMessage(nick);
            this.sidebarMode = 'friends';
            this.scheduleChatStateSave?.();
        },
    };
}
