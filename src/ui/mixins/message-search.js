/**
 * Message Search Mixin
 * Searches the current channel/DM (Ctrl+F or the magnifier in the header). Covers the
 * loaded messages; older ones come in page by page via CHATHISTORY ("load older").
 * Server-side search is a later step.
 */
import { stripFormatting } from '../../core/formatting.js';

export const SEARCH_MIN_LENGTH = 2;

/** Only chat lines are searchable: no join/part, deleted or hidden lines. */
function isSearchable(message) {
    return message && !message._hidden && !message.isJoinPart && !message.redacted
        && !message.serverKind && typeof message.text === 'string';
}

/**
 * Ids of the matching messages, newest first. Matches the text (without mIRC
 * formatting) or the author, case-insensitively.
 *
 * @param {object[]} messages oldest first, as stored
 * @param {string} query
 * @return {Array<string|number>}
 */
export function findMessageMatches(messages, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (needle.length < SEARCH_MIN_LENGTH) return [];
    const ids = [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!isSearchable(message)) continue;
        const text = stripFormatting(message.text).toLowerCase();
        if (text.includes(needle) || String(message.user || '').toLowerCase().includes(needle)) ids.push(message.id);
    }
    return ids;
}

/**
 * Last search, reused while neither the messages nor the query changed. The hit
 * checks run once per rendered row. Not reactive state on purpose (one chat per page).
 */
let cache = { messages: null, length: -1, lastId: null, query: null, ids: [], idSet: new Set() };

function cachedMatches(messages, query) {
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (cache.messages !== messages || cache.length !== messages.length || cache.lastId !== lastId || cache.query !== query) {
        const ids = findMessageMatches(messages, query);
        cache = { messages, length: messages.length, lastId, query, ids, idSet: new Set(ids) };
    }
    return cache;
}

export function messageSearchMixin() {
    return {
        messageSearch: { open: false, query: '', index: 0 },

        openMessageSearch() {
            if (!this.currentChannel || this.isServerWindow?.()) return;
            this.messageSearch = { ...this.messageSearch, open: true };
            this.$nextTick?.(() => {
                const input = this.$refs?.messageSearchInput;
                input?.focus();
                input?.select();
            });
        },

        closeMessageSearch() {
            if (!this.messageSearch.open && !this.messageSearch.query) return;
            this.messageSearch = { open: false, query: '', index: 0 };
        },

        messageSearchResults() {
            if (!this.messageSearch.open) return [];
            return cachedMatches(this.currentMessages, this.messageSearch.query).ids;
        },

        /** New query: start again at the newest hit and show it. */
        messageSearchInput() {
            this.messageSearch.index = 0;
            this.jumpToSearchResult();
        },

        /** +1 = older hit, -1 = newer hit (wraps around). */
        messageSearchStep(delta) {
            const count = this.messageSearchResults().length;
            if (!count) return;
            this.messageSearch.index = (this.messageSearch.index + delta + count) % count;
            this.jumpToSearchResult();
        },

        jumpToSearchResult() {
            const id = this.messageSearchResults()[this.messageSearch.index];
            if (id === undefined) return;
            // Hidden join/part lines and collapsed groups don't matter: hits are chat lines
            this.$nextTick?.(() => {
                const chatWindow = this.$refs?.chatMessages || document.querySelector('.chat-messages');
                const element = chatWindow?.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`);
                element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
        },

        isSearchHit(message) {
            if (!this.messageSearch.open) return false;
            return cachedMatches(this.currentMessages, this.messageSearch.query).idSet.has(message?.id);
        },

        isCurrentSearchHit(message) {
            return this.messageSearch.open && this.messageSearchResults()[this.messageSearch.index] === message?.id;
        },

        /** "3 / 12", empty while nothing is searched. */
        messageSearchCounter() {
            const query = this.messageSearch.query.trim();
            if (query.length < SEARCH_MIN_LENGTH) return '';
            const count = this.messageSearchResults().length;
            return count ? `${this.messageSearch.index + 1} / ${count}` : '0';
        },

        canLoadOlderForSearch() {
            const target = this.currentChannel;
            return Boolean(target) && this.supportsChathistory && this.isRegistered
                && !this.historyExhaustedByTarget[target] && Boolean(this.historyCursorByTarget[target]);
        },

        loadOlderForSearch() {
            if (!this.canLoadOlderForSearch()) return;
            this.requestHistoryBefore(this.currentChannel);
        },
    };
}
