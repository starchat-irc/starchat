/**
 * Channel topics by channel name.
 *
 * @param {import('./store.js').StateStore} store
 */
export function ChannelManager(store) {
    if (!store.get()) {
        store.set({});
    }

    return {
        setTopic: (channel, topic) => {
            const topics = store.get();
            topics[channel] = topic;
            store.set(topics);
        },
        /** Empty string when no topic is known, the UI shows its own placeholder. */
        getTopic: (channel) => store.get()[channel] || '',
        clearTopic: (channel) => {
            const topics = store.get();
            delete topics[channel];
            store.set(topics);
        },
    };
}
