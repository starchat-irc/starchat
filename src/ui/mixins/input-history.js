/**
 * Input History Mixin
 * Arrow up/down in the message input walks through what was sent in this window
 * (channel, DM or server window) during the session, like a shell or a classic IRC client.
 * Not stored, not synced. The text being typed is kept and comes back at the end.
 */

export const INPUT_HISTORY_LIMIT = 50;

/** The caret is in the first (up) or last (down) line and nothing is selected. */
function caretAtEdge(element, direction) {
    if (!element || typeof element.value !== 'string') return true;
    const { value, selectionStart, selectionEnd } = element;
    if (selectionStart !== selectionEnd) return false;
    return direction < 0
        ? value.lastIndexOf('\n', selectionStart - 1) === -1
        : value.indexOf('\n', selectionEnd) === -1;
}

export function inputHistoryMixin() {
    return {
        /** { target: string[] }, oldest first */
        _inputHistory: {},
        /** Position while walking: { target, index, draft } or null */
        _inputHistoryCursor: null,

        /** Remember a sent line for the window it was sent in. */
        recordInputHistory(target, text) {
            const line = String(text || '').trim();
            if (!target || !line) return;
            const list = this._inputHistory[target] || [];
            if (list[list.length - 1] !== line) list.push(line);
            if (list.length > INPUT_HISTORY_LIMIT) list.splice(0, list.length - INPUT_HISTORY_LIMIT);
            this._inputHistory[target] = list;
            this._inputHistoryCursor = null;
        },

        /**
         * Arrow key in the message input: -1 = older, 1 = newer. Leaves the key alone (caret
         * movement) unless the caret is on the first or last line.
         */
        navigateInputHistory(event, direction) {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (this.commandSuggestions?.length) return;

            const target = this.currentChannel;
            const list = this._inputHistory[target] || [];
            if (!list.length) return;
            if (!caretAtEdge(event.target, direction)) return;

            let cursor = this._inputHistoryCursor;
            if (cursor && cursor.target !== target) cursor = null;

            if (direction < 0) {
                if (!cursor) cursor = { target, index: list.length, draft: this.newMessage };
                if (cursor.index === 0) {
                    event.preventDefault();
                    return;
                }
                cursor.index -= 1;
                this.newMessage = list[cursor.index];
            } else {
                if (!cursor) return;
                cursor.index += 1;
                if (cursor.index >= list.length) {
                    this.newMessage = cursor.draft;
                    cursor = null;
                } else {
                    this.newMessage = list[cursor.index];
                }
            }

            event.preventDefault();
            this._inputHistoryCursor = cursor;
            this.$nextTick?.(() => {
                const input = this.$refs?.messageInput;
                if (!input) return;
                this.autoGrowInput?.(input);
                const end = input.value.length;
                input.setSelectionRange?.(end, end);
            });
        },
    };
}
