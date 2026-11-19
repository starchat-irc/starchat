/**
 * Communities module (feature "communities")
 * Groups of channels the user belongs to, loaded from the network's API. Each group gets
 * an icon in the rail; picking it shows only its channels (not joined ones as joinable)
 * and opens its lobby. Home shows every joined channel: channels outside of any group
 * first, then one section per group. API: docs/discovery.md.
 *
 * The filter itself (activeCommunityFilter, openHome) is part of the chat, so other
 * modules can follow it through the hook communityChanged without knowing this one.
 */

import { COMMUNITY_PLACEHOLDER } from '../core/discovery.js';

/** Icons in the rail before the rest is folded into "+N". */
export const VISIBLE_COMMUNITIES = 5;


const SLUG = /^[\p{L}\p{N}_-]+$/u;

function channelName(value) {
    if (typeof value !== 'string') return null;
    const bare = value.trim().replace(/^#+/, '');
    return bare && !/[\s,]/.test(bare) ? `#${bare.toLowerCase()}` : null;
}

/**
 * Communities with a name and an id, channels as lower-case "#name" without duplicates.
 * The lobby is one of the channels, otherwise the first one.
 *
 * @return {{ id: number|string, name: string, slug: string, lobby_channel: string|null, channels: string[] }[]}
 */
export function normalizeCommunities(data) {
    const list = Array.isArray(data) ? data : Array.isArray(data?.communities) ? data.communities : [];
    const seen = new Set();
    return list
        .filter(entry => entry && (typeof entry.id === 'number' || (typeof entry.id === 'string' && entry.id))
            && typeof entry.name === 'string' && entry.name.trim())
        .filter(entry => !seen.has(String(entry.id)) && seen.add(String(entry.id)))
        .map(entry => {
            const channels = [...new Set((Array.isArray(entry.channels) ? entry.channels : []).map(channelName).filter(Boolean))];
            const lobby = channelName(entry.lobby_channel);
            return {
                id: entry.id,
                name: entry.name.trim(),
                slug: typeof entry.slug === 'string' && SLUG.test(entry.slug) ? entry.slug : '',
                lobby_channel: lobby && channels.includes(lobby) ? lobby : channels[0] || null,
                channels,
            };
        });
}

/** Channels of a community, its lobby first. */
function lobbyFirst(community) {
    const lobby = community.lobby_channel;
    return lobby ? [lobby, ...community.channels.filter(channel => channel !== lobby)] : [...community.channels];
}

export function communitiesMixin() {
    return {
        myCommunities: [],
        lastChannelByCommunity: {},
        lastHomeChannel: null,

        canUseCommunities() {
            return this.hasFeature('communities') && this.hasApiToken;
        },

        async fetchMyCommunities() {
            if (!this.canUseCommunities()) {
                this.clearCommunities();
                return;
            }
            try {
                const response = await this.connection.api('my-communities');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this.myCommunities = normalizeCommunities(await response.json());
                // Left the community elsewhere: back to Home
                if (this.activeCommunityFilter !== null && !this.activeCommunity()) {
                    this.activeCommunityFilter = null;
                    this.callModuleHook('communityChanged', null);
                }
            } catch (error) {
                console.warn('Could not load communities:', error);
            }
        },

        clearCommunities() {
            this.myCommunities = [];
            this.lastChannelByCommunity = {};
            this.activeCommunityFilter = null;
        },

        activeCommunity() {
            if (this.activeCommunityFilter === null) return null;
            return this.myCommunities.find(community => community.id === this.activeCommunityFilter) || null;
        },

        visibleCommunities() {
            return this.myCommunities.slice(0, VISIBLE_COMMUNITIES);
        },

        hiddenCommunityCount() {
            return Math.max(0, this.myCommunities.length - VISIBLE_COMMUNITIES);
        },

        /**
         * Home: the lobby of the network and channels outside of my communities first, then
         * one group per community (its lobby first, then the owner's order). A channel in
         * several communities is listed under the first one.
         *
         * @return {{ communityId: number|string|null, label: string|null, channels: string[] }[]}
         */
        homeChannelGroups() {
            const joined = this.availableChannels.filter(channel => channel.startsWith('#'));
            const lobby = this.lobbyChannel;
            const placed = new Set(lobby && joined.includes(lobby) ? [lobby] : []);
            const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

            const groups = this.myCommunities.map(community => {
                const own = lobbyFirst(community).filter(channel => joined.includes(channel) && !placed.has(channel));
                own.forEach(channel => placed.add(channel));
                return { communityId: community.id, label: community.name, channels: own };
            }).filter(group => group.channels.length);

            const loose = joined.filter(channel => !placed.has(channel)).sort(byName);
            const top = [...(lobby && joined.includes(lobby) ? [lobby] : []), ...loose];
            return [...(top.length ? [{ communityId: null, label: null, channels: top }] : []), ...groups];
        },

        /**
         * Channel list of the sidebar (used by channelListEntries). Home lists every joined
         * channel with a group label on the first channel of each community. A community
         * lists all of its channels, the ones not joined yet as joinable.
         */
        channelEntries() {
            const community = this.activeCommunity();
            if (!community) {
                return this.homeChannelGroups().flatMap(group => group.channels.map((name, index) => ({
                    name,
                    joined: true,
                    ...(group.label && index === 0 ? { groupLabel: group.label } : {}),
                })));
            }
            return lobbyFirst(community).map(name => ({ name, joined: this.availableChannels.includes(name) }));
        },

        communityMentionCount(community) {
            return (community?.channels || []).reduce((sum, channel) => sum + (this.mentionsByChannel[channel] || 0), 0);
        },

        communityHasUnread(community) {
            return (community?.channels || []).some(channel => this.availableChannels.includes(channel) && this.hasUnread(channel));
        },

        /**
         * Rail icon: show the community and land in the channel last used there, otherwise
         * in its lobby (joined on demand, the JOIN then shows it).
         */
        openCommunity(community) {
            if (!community) return;
            const changed = this.activeCommunityFilter !== community.id;
            this.activeCommunityFilter = community.id;
            this.enterChannelsMode();
            if (changed) this.callModuleHook('communityChanged', community.id);

            const joined = channel => Boolean(channel) && this.availableChannels.includes(channel);
            const remembered = this.lastChannelByCommunity[community.id];
            const target = joined(remembered) ? remembered
                : community.lobby_channel || community.channels.find(joined) || community.channels[0];
            if (!target) return;
            if (joined(target)) this.switchChannel(target);
            else this.joinChannel(target);
        },

        /**
         * A channel became visible (switchChannel). A community that does not contain it
         * gives way to Home; the channel is remembered for the view it is shown in.
         */
        onChannelShown(channel) {
            const community = this.activeCommunity();
            if (community && !community.channels.includes(channel)) {
                this.activeCommunityFilter = null;
                this.callModuleHook('communityChanged', null);
            }
            if (this.activeCommunityFilter === null) this.lastHomeChannel = channel;
            else this.lastChannelByCommunity = { ...this.lastChannelByCommunity, [this.activeCommunityFilter]: channel };
        },

        /** Invite page of the network for a community (links.communityInvite), or null. */
        communityInviteUrl(community) {
            const template = this.networkLink('communityInvite');
            if (!template || !community?.slug) return null;
            return template.replace(COMMUNITY_PLACEHOLDER, encodeURIComponent(community.slug));
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const communitiesModule = {
    name: 'communities',
    mixin: communitiesMixin,
    hooks: {
        /** After every registration: memberships may have changed while we were away. */
        registered() {
            this.fetchMyCommunities();
        },
        loggedOut() {
            this.clearCommunities();
        },
    },
};
