/**
 * Channel Management Mixin
 * Op tools for the current channel: topic, modes, ban/exception/invex lists, kick/ban.
 * Panel state lives in the channelManagement store, see createChannelManagementState().
 */

/** Initial state of the channelManagement store. */
export function createChannelManagementState() {
    return {
        showPanel: false,
        showTopicEditor: false,
        showListManager: false,
        listManagerTab: 'ban',
        topicDraft: '',
        channelModesDraft: '',
        customModesDraft: '',
        commonChannelModes: ['n', 't', 'm', 'i', 's', 'E'],
        standardModeState: { n: false, t: false, m: false, i: false, s: false, E: false },
        banList: [],
        exceptionList: [],
        invexList: [],
    };
}

export function channelManagementMixin() {
    return {
        channelManagementStore() {
            return this.stores.channelManagement.get();
        },

        getCurrentUserRole(channel = this.currentChannel) {
            const users = this.reactiveUsers[channel] || [];
            const me = users.find(user => user.name === this.nickname);
            return me?.role || '';
        },

        canManageCurrentChannel() {
            if (!this.currentChannel?.startsWith('#')) return false;
            return ['~', '&', '@', '%'].includes(this.getCurrentUserRole());
        },

        applyChannelTopic() {
            if (!this.canManageCurrentChannel()) return;
            const safeTopic = (this.channelManagementStore().topicDraft || '').trim();
            this.sendRaw(`TOPIC ${this.currentChannel} :${safeTopic}`);
            this.channelManagementStore().showTopicEditor = false;
        },

        insertTopicColorCode(event) {
            if (!event?.ctrlKey || event.key.toLowerCase() !== 'k') return;
            event.preventDefault();
            this.channelManagementStore().topicDraft += '\u0003';
        },

        openTopicEditor() {
            if (!this.canManageCurrentChannel()) return;
            this.channelManagementStore().topicDraft = this.channelManager.getTopic(this.currentChannel);
            this.channelManagementStore().showTopicEditor = true;
        },

        openChannelManagement() {
            if (!this.canManageCurrentChannel()) return;
            this.channelManagementStore().showPanel = true;
            this.channelManagementStore().channelModesDraft = '';
            this.channelManagementStore().customModesDraft = '';
            this.sendRaw(`MODE ${this.currentChannel}`);
        },

        openChannelListManager(tab = 'ban') {
            if (!this.canManageCurrentChannel()) return;
            this.channelManagementStore().listManagerTab = tab;
            this.channelManagementStore().showListManager = true;
            this.channelManagementStore().banList = [];
            this.channelManagementStore().exceptionList = [];
            this.channelManagementStore().invexList = [];
            this.sendRaw(`MODE ${this.currentChannel} +b`);
            this.sendRaw(`MODE ${this.currentChannel} +e`);
            this.sendRaw(`MODE ${this.currentChannel} +I`);
        },

        parseChannelModeState(modeExpression = '') {
            const store = this.channelManagementStore();
            const next = { ...(store.standardModeState || { n: false, t: false, m: false, i: false, s: false, E: false }) };
            let op = null;
            for (const ch of String(modeExpression)) {
                if (ch === '+' || ch === '-') { op = ch; continue; }
                if (!Object.prototype.hasOwnProperty.call(next, ch) || !op) continue;
                next[ch] = op === '+';
            }
            store.standardModeState = next;
        },

        setStandardMode(mode, enabled) {
            if (!this.canManageCurrentChannel() || !mode) return;
            const store = this.channelManagementStore();
            store.standardModeState = { ...store.standardModeState, [mode]: !!enabled };
            this.sendRaw(`MODE ${this.currentChannel} ${enabled ? '+' : '-'}${mode}`);
        },

        applyModeShortcut(token) {
            if (!this.canManageCurrentChannel() || !token) return;
            const cleaned = String(token).trim();
            if (!cleaned) return;
            this.sendRaw(`MODE ${this.currentChannel} ${cleaned}`);
        },

        applyChannelModes() {
            if (!this.canManageCurrentChannel() || !this.channelManagementStore().channelModesDraft.trim()) return;
            this.sendRaw(`MODE ${this.currentChannel} ${this.channelManagementStore().channelModesDraft.trim()}`);
            this.channelManagementStore().channelModesDraft = '';
        },

        applyCustomModes() {
            if (!this.canManageCurrentChannel() || !this.channelManagementStore().customModesDraft.trim()) return;
            this.sendRaw(`MODE ${this.currentChannel} ${this.channelManagementStore().customModesDraft.trim()}`);
            this.channelManagementStore().customModesDraft = '';
        },

        applyUserMode(target, mode) {
            if (!this.canManageCurrentChannel() || !target || !mode) return;
            this.sendRaw(`MODE ${this.currentChannel} ${mode} ${target}`);
            this.showingUserOptions = false;
        },

        kickUser(target) {
            if (!this.canManageCurrentChannel() || !target) return;
            this.sendRaw(`KICK ${this.currentChannel} ${target} :Requested by ${this.nickname}`);
            this.showingUserOptions = false;
        },

        banAndKickUser(target) {
            if (!this.canManageCurrentChannel() || !target) return;
            this.sendRaw(`MODE ${this.currentChannel} +b ${target}!*@*`);
            this.sendRaw(`KICK ${this.currentChannel} ${target} :Banned by ${this.nickname}`);
            this.showingUserOptions = false;
        },

        refreshChannelLists() {
            if (!this.canManageCurrentChannel()) return;
            this.channelManagementStore().banList = [];
            this.channelManagementStore().exceptionList = [];
            this.channelManagementStore().invexList = [];
            this.sendRaw(`MODE ${this.currentChannel} +b`);
            this.sendRaw(`MODE ${this.currentChannel} +e`);
            this.sendRaw(`MODE ${this.currentChannel} +I`);
        },

        removeBan(mask) {
            if (!this.canManageCurrentChannel() || !mask) return;
            this.sendRaw(`MODE ${this.currentChannel} -b ${mask}`);
            this.channelManagementStore().banList = this.channelManagementStore().banList.filter(entry => entry.mask !== mask);
            this.refreshChannelLists();
        },

        removeException(mask) {
            if (!this.canManageCurrentChannel() || !mask) return;
            this.sendRaw(`MODE ${this.currentChannel} -e ${mask}`);
            this.channelManagementStore().exceptionList = this.channelManagementStore().exceptionList.filter(entry => entry.mask !== mask);
            this.refreshChannelLists();
        },

        removeInvex(mask) {
            if (!this.canManageCurrentChannel() || !mask) return;
            this.sendRaw(`MODE ${this.currentChannel} -I ${mask}`);
            this.channelManagementStore().invexList = this.channelManagementStore().invexList.filter(entry => entry.mask !== mask);
            this.refreshChannelLists();
        },
    };
}
