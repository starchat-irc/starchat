/**
 * Channel list of the server (LIST) in the explore dialog. Plain IRC, works on every
 * network. The explore module adds a tab with the network's directory.
 * filteredServerChannels is a getter and therefore lives in the component.
 */
export function channelListMixin() {
    return {
        serverChannels: [],
        isListing: false,
        exploreSearch: '',
        exploreDialog: { show: false, tab: 'list' },

        requestChannelList() {
            if (!this.isRegistered) return;
            this.serverChannels = [];
            this.isListing = true;
            this.sendRaw('LIST');
        },

        /** @param {'list'|'directory'} tab */
        openExplore(tab = 'list') {
            this.exploreDialog = { show: true, tab };
            this.exploreSearch = '';
            this.showExploreTab(tab);
        },

        showExploreTab(tab) {
            this.exploreDialog.tab = tab;
            if (tab === 'list') {
                this.requestChannelList();
            } else {
                this.callModuleHook('exploreTabOpened', tab);
            }
        },

        closeExplore() {
            this.exploreDialog = { show: false, tab: this.exploreDialog.tab };
        },

        /** Whether this session is in the channel (server lists keep their own casing). */
        isChannelJoined(name) {
            const needle = String(name || '').toLowerCase();
            return Boolean(needle) && this.availableChannels.some(channel => channel.toLowerCase() === needle);
        },
    };
}
