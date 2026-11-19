/**
 * Explore module (feature "explore")
 * Directory of the network in the explore dialog: groups of channels (communities)
 * that are joined together. The channel list of the server (LIST) is part of the core.
 * API: docs/discovery.md.
 */

/** Groups with a name and at least one channel name. */
export function normalizeDirectory(data) {
    const groups = Array.isArray(data?.communities) ? data.communities : [];
    return groups
        .filter(group => group && typeof group.name === 'string' && Array.isArray(group.channel_names))
        .map(group => ({
            id: group.id ?? group.name,
            name: group.name,
            description: typeof group.description === 'string' ? group.description : '',
            channel_names: group.channel_names.filter(name => typeof name === 'string' && name.startsWith('#')),
        }))
        .filter(group => group.channel_names.length > 0);
}

export function exploreMixin() {
    return {
        communities: [],
        directoryLoading: false,
        directoryError: false,

        async fetchDirectory() {
            if (!this.hasFeature('explore')) return;
            this.directoryLoading = true;
            this.directoryError = false;
            try {
                const response = await this.connection.api('explore');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this.communities = normalizeDirectory(await response.json());
            } catch (error) {
                console.warn('Could not load the directory:', error);
                this.communities = [];
                this.directoryError = true;
            } finally {
                this.directoryLoading = false;
            }
        },

        /** Channels of a group this session is not in yet. */
        missingCommunityChannels(community) {
            return (community?.channel_names || []).filter(name => !this.isChannelJoined(name));
        },

        /** In every channel of the group: nothing left to join. */
        isCommunityJoined(community) {
            return (community?.channel_names || []).length > 0 && this.missingCommunityChannels(community).length === 0;
        },

        joinCommunity(community) {
            this.missingCommunityChannels(community).forEach(channel => this.joinChannel(channel));
            this.closeExplore();
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const exploreModule = {
    name: 'explore',
    mixin: exploreMixin,
    hooks: {
        exploreTabOpened(tab) {
            if (tab === 'directory') this.fetchDirectory();
        },
    },
};
