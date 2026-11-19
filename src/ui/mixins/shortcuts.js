/**
 * Shortcuts Mixin
 * Keyboard shortcuts of the chat:
 *  - Ctrl+P            quick switcher (channels, DMs, friends). Ctrl+K stays the mIRC colour picker.
 *  - Ctrl+F            search in the current channel/DM
 *  - Alt+Up / Alt+Down previous / next entry of the sidebar list
 *  - ? (outside inputs), Ctrl+/   overview of all shortcuts
 */
import { SERVER_WINDOW } from './server-window.js';

export const QUICK_SWITCHER_LIMIT = 10;

/** Shortcut overview. Label keys are translated in the view. */
export const SHORTCUTS = [
    { keys: ['Ctrl', 'P'], label: 'shortcut_quick_switcher' },
    { keys: ['Ctrl', 'F'], label: 'shortcut_search' },
    { keys: ['Alt', '↑'], label: 'shortcut_previous_channel' },
    { keys: ['Alt', '↓'], label: 'shortcut_next_channel' },
    { keys: ['Ctrl', 'K'], label: 'shortcut_color' },
    { keys: ['Ctrl', 'B'], label: 'shortcut_bold' },
    { keys: ['Ctrl', 'I'], label: 'shortcut_italic' },
    { keys: ['Ctrl', 'U'], label: 'shortcut_underline' },
    { keys: ['Tab'], label: 'shortcut_complete' },
    { keys: ['Shift', 'Enter'], label: 'shortcut_newline' },
    { keys: ['Esc'], label: 'shortcut_escape' },
    { keys: ['?'], label: 'shortcut_help' },
];

function normalize(text) {
    return String(text ?? '').toLowerCase().replace(/^#/, '');
}

/** 0 = starts with, 1 = contains, 2 = letters in order ("stc" -> "starchat"), null = no match. */
function matchScore(name, query) {
    if (!query) return 0;
    const haystack = normalize(name);
    if (haystack.startsWith(query)) return 0;
    if (haystack.includes(query)) return 1;
    let position = 0;
    for (const char of query) {
        position = haystack.indexOf(char, position);
        if (position === -1) return null;
        position++;
    }
    return 2;
}

/**
 * Entries of the quick switcher, best first.
 *
 * @param {{ name: string, kind: 'channel'|'dm'|'friend', unread?: number, mentions?: number }[]} targets
 * @param {string} query
 * @param {{ current?: string, limit?: number }} options
 * @return {{ name: string, kind: string, unread: number, mentions: number }[]}
 */
export function rankSwitcherTargets(targets, query, { current = '', limit = QUICK_SWITCHER_LIMIT } = {}) {
    const needle = normalize(query).trim();
    const seen = new Set();
    return targets
        .filter((target) => {
            const key = target.name.toLowerCase();
            if (!target.name || seen.has(key)) return false;
            seen.add(key);
            // Without a query the current window is no useful destination
            return needle !== '' || target.name !== current;
        })
        .map(target => ({ ...target, unread: target.unread || 0, mentions: target.mentions || 0, score: matchScore(target.name, needle) }))
        .filter(target => target.score !== null)
        .sort((a, b) => a.score - b.score
            || b.mentions - a.mentions
            || (b.unread > 0) - (a.unread > 0)
            || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, limit)
        .map(({ score, ...target }) => target);
}

/** Typing in a text field must not trigger single-key shortcuts like "?". */
function isTypingTarget(element) {
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}

export function shortcutsMixin() {
    return {
        /** mode "share": the chosen conversation receives a shared text/file (mixins/share.js). */
        quickSwitcher: { show: false, query: '', index: 0, mode: 'switch' },
        showShortcutHelp: false,
        shortcuts: SHORTCUTS,

        /** Registered once on the document (see main.js init). */
        handleGlobalKeydown(event) {
            const key = event.key;
            const ctrl = event.ctrlKey || event.metaKey;

            if (ctrl && !event.altKey && !event.shiftKey && key.toLowerCase() === 'p') {
                event.preventDefault();
                this.quickSwitcher.show ? this.closeQuickSwitcher() : this.openQuickSwitcher();
                return;
            }
            if (ctrl && !event.altKey && !event.shiftKey && key.toLowerCase() === 'f') {
                event.preventDefault();
                this.openMessageSearch();
                return;
            }
            if ((ctrl && key === '/') || (key === '?' && !ctrl && !event.altKey && !isTypingTarget(event.target))) {
                event.preventDefault();
                this.showShortcutHelp = !this.showShortcutHelp;
                return;
            }
            if (event.altKey && !ctrl && !event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
                event.preventDefault();
                this.switchRelativeTarget(key === 'ArrowUp' ? -1 : 1);
                return;
            }
            if (key === 'Escape' && this.showShortcutHelp) {
                this.showShortcutHelp = false;
            }
        },

        // Alt+Up/Down

        /** The list the sidebar currently shows: channels of the view, or the DMs. */
        sidebarTargets() {
            if (this.sidebarMode === 'friends') {
                return this.privateMessageKeys.filter(key => key !== SERVER_WINDOW);
            }
            return this.sortedChannels;
        },

        switchRelativeTarget(delta) {
            const targets = this.sidebarTargets();
            if (!targets.length) return;
            const index = targets.indexOf(this.currentChannel);
            const next = index === -1
                ? (delta > 0 ? 0 : targets.length - 1)
                : (index + delta + targets.length) % targets.length;
            if (targets[next] !== this.currentChannel) this.switchChannel(targets[next]);
        },

        // Quick switcher

        openQuickSwitcher(mode = 'switch') {
            this.showShortcutHelp = false;
            this.contextMenu.show = false;
            if (mode !== 'share') this.pendingShare = null;
            this.quickSwitcher = { show: true, query: '', index: 0, mode };
        },

        closeQuickSwitcher() {
            this.quickSwitcher = { show: false, query: '', index: 0, mode: 'switch' };
            this.pendingShare = null;
            this.$nextTick?.(() => this.focusMessageInput?.());
        },

        quickSwitcherItems() {
            const channels = this.availableChannels
                .filter(name => name.startsWith('#'))
                .map(name => ({ name, kind: 'channel' }));
            const dms = this.privateMessageKeys
                .filter(name => name !== SERVER_WINDOW)
                .map(name => ({ name, kind: 'dm' }));
            const friends = (this.friends || [])
                .map(friend => friend.user?.display)
                .filter(Boolean)
                .map(name => ({ name, kind: 'friend' }));
            const targets = [...channels, ...dms, ...friends].map(target => ({
                ...target,
                unread: this.unreadMessages[target.name] || 0,
                mentions: this.mentionsByChannel[target.name] || 0,
            }));
            // Sharing into the open conversation is a perfectly good choice
            const current = this.quickSwitcher.mode === 'share' ? '' : this.currentChannel;
            return rankSwitcherTargets(targets, this.quickSwitcher.query, { current });
        },

        quickSwitcherInput() {
            this.quickSwitcher.index = 0;
        },

        quickSwitcherMove(delta) {
            const count = this.quickSwitcherItems().length;
            if (!count) return;
            this.quickSwitcher.index = (this.quickSwitcher.index + delta + count) % count;
        },

        quickSwitcherConfirm(item = null) {
            const target = item || this.quickSwitcherItems()[this.quickSwitcher.index];
            if (!target) return;
            const share = this.pendingShare;
            this.closeQuickSwitcher();
            if (target.kind === 'channel') this.switchChannel(target.name);
            else this.sendPrivateMessage(target.name);
            if (share) this.$nextTick?.(() => this.applyShare(share));
        },
    };
}
