/**
 * Completion Mixin
 * Tab completion in the message input: nicks (recent speakers first), #channels
 * and /commands. Repeated Tab cycles through the matches, Shift+Tab goes back.
 * A nick completed at the start of the line gets the usual "nick: " suffix.
 */
import { commands } from '../../core/commands.js';

/** How many recent messages are scanned to rank nicks by activity. */
const RECENT_SPEAKER_SCAN = 200;

function startsWithIgnoreCase(value, prefix) {
    return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function byName(a, b) {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

export function completionMixin() {
    return {
        _tabCompletion: null,

        /**
         * Nicks for the current target: recent speakers first, then everybody else alphabetically.
         *
         * @return {string[]}
         */
        completionNicks() {
            const target = this.currentChannel;
            if (!target) return [];
            const own = (this.nickname || '').toLowerCase();

            const members = target.startsWith('#')
                ? this.activeUsers.get(target).map(user => user.name)
                : [target];

            const recent = [];
            const messages = this.messageManager.get(target);
            for (let i = messages.length - 1; i >= 0 && messages.length - i <= RECENT_SPEAKER_SCAN; i--) {
                const message = messages[i];
                if (message._hidden || message.isJoinPart || message.isSystem || !message.user) continue;
                if (!recent.some(nick => nick.toLowerCase() === message.user.toLowerCase())) recent.push(message.user);
            }

            const memberSet = new Set(members.map(nick => nick.toLowerCase()));
            // In a channel only current members are offered, recent speakers who left are skipped
            const ranked = target.startsWith('#')
                ? recent.filter(nick => memberSet.has(nick.toLowerCase()))
                : recent;
            const rankedSet = new Set(ranked.map(nick => nick.toLowerCase()));
            const rest = members.filter(nick => !rankedSet.has(nick.toLowerCase())).sort(byName);

            return [...ranked, ...rest].filter(nick => nick && nick.toLowerCase() !== own);
        },

        /**
         * All completions for a word.
         *
         * @param {string} word the word left of the caret
         * @param {boolean} atLineStart whether the word starts the line
         * @return {{ text: string, suffix: string }[]}
         */
        completionCandidates(word, atLineStart) {
            if (word.startsWith('/') && atLineStart) {
                const prefix = word.slice(1);
                return Object.keys(commands)
                    .filter(command => startsWithIgnoreCase(command, prefix))
                    .sort(byName)
                    .map(command => ({ text: `/${command}`, suffix: ' ' }));
            }

            if (word.startsWith('#')) {
                return [...new Set(this.availableChannels)]
                    .filter(channel => startsWithIgnoreCase(channel, word))
                    .sort(byName)
                    .map(channel => ({ text: channel, suffix: ' ' }));
            }

            const at = word.startsWith('@') ? '@' : '';
            const prefix = word.slice(at.length);
            if (!prefix && !at) return [];
            return this.completionNicks()
                .filter(nick => startsWithIgnoreCase(nick, prefix))
                .map(nick => ({ text: at + nick, suffix: atLineStart && !at ? ': ' : ' ' }));
        },

        /**
         * Keydown handler for Tab in the message input.
         *
         * @param {KeyboardEvent} event
         */
        handleTabCompletion(event) {
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            const input = event.target;
            const value = this.newMessage || '';
            const caret = typeof input?.selectionStart === 'number' ? input.selectionStart : value.length;

            let state = this._tabCompletion;
            const continuing = state && state.value === value && state.caret === caret;

            if (!continuing) {
                const word = value.slice(0, caret).match(/\S*$/)[0];
                // Nothing typed: keep the default Tab behaviour (focus navigation)
                if (!word) {
                    this._tabCompletion = null;
                    return;
                }
                const start = caret - word.length;
                state = {
                    start,
                    after: value.slice(caret).replace(/^ /, ''),
                    candidates: this.completionCandidates(word, start === 0),
                    index: -1,
                };
            }

            event.preventDefault();
            if (!state.candidates.length) {
                this._tabCompletion = null;
                return;
            }

            const count = state.candidates.length;
            const step = event.shiftKey ? -1 : 1;
            state.index = state.index === -1
                ? (event.shiftKey ? count - 1 : 0)
                : (state.index + step + count) % count;
            const { text, suffix } = state.candidates[state.index];
            const completion = text + suffix;

            this.newMessage = value.slice(0, state.start) + completion + state.after;
            state.value = this.newMessage;
            state.caret = state.start + completion.length;
            this._tabCompletion = state;
            this.commandSuggestions = [];

            const position = state.caret;
            this.$nextTick?.(() => input?.setSelectionRange?.(position, position));
        },
    };
}
