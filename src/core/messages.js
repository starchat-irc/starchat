export const MESSAGE_LIMIT = 1000;

let nextMessageId = 1;

/**
 * Message lists per target (channel or nick). Targets starting with "#" are
 * channels, everything else is a private conversation.
 *
 * @param {import('./store.js').StateStore} store
 * @param {{ onAdd?: (target: string, entry: Object) => void }} [hooks] onAdd sees every live message, e.g. for a log file.
 */
export function MessageManager(store, { onAdd } = {}) {
    store.set({});

    // Collects messages during a BATCH, flushed on BATCH end
    const batchBuffer = {};

    function ensureTarget(target) {
        if (!store.get()[target]) {
            store.get()[target] = { type: target.startsWith('#') ? 'channel' : 'private', content: [] };
        }
    }

    /**
     * Give every message a stable id (used as list key and unread anchor) and an epoch timestamp.
     */
    function normalize(entry) {
        if (entry.id == null) entry.id = nextMessageId++;
        if (typeof entry._ts !== 'number') entry._ts = Date.now();
        return entry;
    }

    function enforceLimit(target) {
        const list = store.get()[target];
        if (list.content.length > MESSAGE_LIMIT) {
            list.content.splice(0, list.content.length - MESSAGE_LIMIT);
        }
    }

    return {
        /**
         * Append a message at the end (live and new messages).
         * Returns the stored (reactive) entry.
         */
        add: (target, entry) => {
            ensureTarget(target);
            const content = store.get()[target].content;
            content.push(normalize(entry));
            enforceLimit(target);
            onAdd?.(target, entry);
            return content[content.length - 1];
        },

        /**
         * Buffer a message for later batch insertion.
         * The store is not touched until flushBuffer() is called.
         */
        bufferAdd: (target, entry) => {
            if (!batchBuffer[target]) {
                batchBuffer[target] = [];
            }
            batchBuffer[target].push(normalize(entry));
        },

        /**
         * Flush all buffered messages into the store at once and sort chronologically.
         * Returns the flushed entries.
         */
        flushBuffer: (target) => {
            const buffered = batchBuffer[target] || [];
            delete batchBuffer[target];
            if (buffered.length === 0) {
                return [];
            }

            ensureTarget(target);
            const list = store.get()[target];
            list.content = [...list.content, ...buffered].sort((a, b) => (a._ts || 0) - (b._ts || 0));
            enforceLimit(target);

            return buffered;
        },

        ensure: (target) => ensureTarget(target),
        get: (target) => store.get()[target]?.content || [],
        remove: (target) => {
            delete store.get()[target];
            delete batchBuffer[target];
        },
        keys: () => Object.keys(store.get()),
        privateKeys: () => Object.keys(store.get()).filter((k) => store.get()[k].type === 'private' && k !== 'Server'),
    };
}
