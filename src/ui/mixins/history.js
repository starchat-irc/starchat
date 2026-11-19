/**
 * History Mixin
 * CHATHISTORY protocol helpers: dedup keys, cursor tracking, and page requests.
 */
/** Latest-history requests sent at the same time (keeps the server's flood limit happy). */
const HISTORY_PARALLEL = 2;
const HISTORY_TIMEOUT_MS = 5000;

export function historyMixin() {
    return {
        historyPageSize:            50,
        historyCursorByTarget:      {},
        historyLoadingByTarget:     {},
        historyRequestTypeByTarget: {},
        historyLoadedByTarget:      {},
        historyBatchTargetById:     {},
        historyExhaustedByTarget:   {},
        historyReceivedByTarget:    {},
        seenMessageKeysByTarget:    {},
        _historyQueue: [],
        _historyInFlight: new Map(), // target -> request id
        _historyRequestSeq: 0,

        ensureSeenMessageBucket(target) {
            if (!this.seenMessageKeysByTarget[target]) {
                this.seenMessageKeysByTarget[target] = new Set();
            }
            return this.seenMessageKeysByTarget[target];
        },

        getMessageDedupKey(target, sender, text, isNotice, tagData) {
            if (tagData?.msgid) return `${target}|msgid|${tagData.msgid}`;
            const time = tagData?.time || '';
            return `${target}|${isNotice ? 'notice' : 'privmsg'}|${time}|${sender}|${text}`;
        },

        updateHistoryCursor(target, tagData) {
            const timestamp = tagData?.time;
            if (!timestamp) return;
            const cur = this.historyCursorByTarget[target];
            if (!cur || new Date(timestamp) < new Date(cur)) {
                this.historyCursorByTarget[target] = timestamp;
            }
        },

        /**
         * Queue the latest history page of a target. Requests are sent at most
         * HISTORY_PARALLEL at a time, the channel on screen first, so it shows up
         * right away instead of waiting behind every other channel and DM.
         */
        requestHistoryLatest(target, force = false) {
            if (!this.isRegistered || !this.supportsChathistory || !target) return;
            if (this.historyLoadingByTarget[target]) return;
            if (this.historyLoadedByTarget[target] && !force) return;

            this.historyLoadingByTarget[target]     = true;
            this.historyRequestTypeByTarget[target] = 'latest';
            this.historyLoadedByTarget[target]      = true;

            if (this.isPriorityHistoryTarget(target)) this._historyQueue.unshift(target);
            else this._historyQueue.push(target);
            this.pumpHistoryQueue();
        },

        isPriorityHistoryTarget(target) {
            return target === this.currentChannel || target === this._pendingActiveChannel;
        },

        /**
         * Move a still waiting request to the front (user switched to it).
         */
        prioritizeHistory(target) {
            const index = this._historyQueue.indexOf(target);
            if (index > 0) {
                this._historyQueue.splice(index, 1);
                this._historyQueue.unshift(target);
            }
        },

        pumpHistoryQueue() {
            while (this._historyInFlight.size < HISTORY_PARALLEL && this._historyQueue.length > 0) {
                const target    = this._historyQueue.shift();
                const requestId = ++this._historyRequestSeq;
                this._historyInFlight.set(target, requestId);
                this.sendRaw(`CHATHISTORY LATEST ${target} * ${this.historyPageSize}`);
                // No answer (e.g. unknown target): don't block the queue
                setTimeout(() => this.completeHistoryRequest(target, requestId), HISTORY_TIMEOUT_MS);
            }
        },

        /**
         * A latest-request finished (batch end, or its timeout): free its slot.
         */
        completeHistoryRequest(target, requestId = null) {
            const inFlight = this._historyInFlight.get(target);
            if (inFlight === undefined || (requestId !== null && inFlight !== requestId)) return;
            this._historyInFlight.delete(target);
            this.historyLoadingByTarget[target] = false;
            this.pumpHistoryQueue();
        },

        resetHistoryQueue() {
            this._historyQueue = [];
            this._historyInFlight = new Map();
        },

        requestHistoryBefore(target) {
            if (!this.isRegistered || !this.supportsChathistory || !target) return;
            if (this.historyLoadingByTarget[target] || this.historyExhaustedByTarget[target]) return;
            const cursor = this.historyCursorByTarget[target];
            if (!cursor) return;

            this.historyLoadingByTarget[target]     = true;
            this.historyRequestTypeByTarget[target] = 'before';
            this.sendRaw(`CHATHISTORY BEFORE ${target} timestamp=${cursor} ${this.historyPageSize}`);
            setTimeout(() => { this.historyLoadingByTarget[target] = false; }, HISTORY_TIMEOUT_MS);
        },
    };
}
