/**
 * Drafts Mixin
 * Unsent text per channel/DM. Survives channel switches (in memory) and restarts
 * (localStorage, per storage scope like the other connection preferences).
 */
import { connectionStorageKey } from './preferences.js';

export const DRAFTS_STORAGE_KEY = 'chat.drafts';
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DRAFT_MAX_ENTRIES = 50;
export const DRAFT_MAX_LENGTH = 8000;

/**
 * Stored drafts as { target: text }. Old, empty and surplus entries are dropped.
 *
 * @param {string|null} raw JSON from storage: { target: { text, at } }
 * @param {number} now
 * @return {Object<string, string>}
 */
export function parseStoredDrafts(raw, now = Date.now()) {
    let data;
    try {
        data = JSON.parse(raw || '{}');
    } catch {
        return {};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

    return Object.fromEntries(
        Object.entries(data)
            .filter(([target, entry]) => target
                && typeof entry?.text === 'string' && entry.text.trim() !== ''
                && Number.isFinite(entry.at) && now - entry.at <= DRAFT_MAX_AGE_MS)
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, DRAFT_MAX_ENTRIES)
            .map(([target, entry]) => [target, entry.text.slice(0, DRAFT_MAX_LENGTH)]),
    );
}

/**
 * @param {Object<string, {text: string, at: number}>} entries
 * @return {string}
 */
export function serializeDrafts(entries) {
    const kept = Object.entries(entries)
        .filter(([, entry]) => entry.text.trim() !== '')
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, DRAFT_MAX_ENTRIES)
        .map(([target, entry]) => [target, { text: entry.text.slice(0, DRAFT_MAX_LENGTH), at: entry.at }]);
    return JSON.stringify(Object.fromEntries(kept));
}

function readStoredEntries(scope) {
    try {
        return JSON.parse(localStorage.getItem(connectionStorageKey(DRAFTS_STORAGE_KEY, scope)) || '{}') || {};
    } catch {
        return {};
    }
}

function loadDrafts(scope) {
    try {
        return parseStoredDrafts(localStorage.getItem(connectionStorageKey(DRAFTS_STORAGE_KEY, scope)));
    } catch {
        return {};
    }
}

/**
 * @param {Object} [options]
 * @param {string} [options.storageScope]
 */
export function draftsMixin({ storageScope = '' } = {}) {
    return {
        storageScope,
        channelDrafts: loadDrafts(storageScope),

        /** Another connection: read its stored drafts. */
        switchDraftScope(scope) {
            this.storageScope = scope;
            this.channelDrafts = loadDrafts(scope);
        },

        /** Remember (or forget, when empty) the draft of a target, in memory and on disk. */
        saveDraft(target, text) {
            if (!target) return;
            const value = String(text ?? '');
            if (value.trim() === '') delete this.channelDrafts[target];
            else this.channelDrafts[target] = value;

            const entries = readStoredEntries(this.storageScope);
            if (value.trim() === '') delete entries[target];
            else entries[target] = { text: value, at: Date.now() };
            try {
                localStorage.setItem(connectionStorageKey(DRAFTS_STORAGE_KEY, this.storageScope), serializeDrafts(entries));
            } catch {
                // storage unavailable (private mode): the draft still survives channel switches
            }
        },

        clearDraft(target) {
            this.saveDraft(target, '');
        },

        /** Put the draft of the current target into the input, unless something is typed already. */
        restoreCurrentDraft() {
            if (this.newMessage || !this.currentChannel) return;
            this.newMessage = this.channelDrafts[this.currentChannel] || '';
            if (this.newMessage) this.$nextTick?.(() => this.autoGrowInput?.(this.$refs?.messageInput));
        },
    };
}
