import { normalizeChannelName } from './server-select.js';

/**
 * Messages from the app around the chat (desktop shell, mobile app) to the chat. The page
 * that mounts the chat passes them in with mountChat({ shellMessages }); see docs/options.md.
 *
 * Only the types listed here do something. Everything else goes to the modules
 * (hook `shellMessage`), so a module can answer its own requests, e.g. the connections page.
 */
export function shellMixin() {
    return {
        /** Channel of an irc:// link that arrived before the registration. */
        _pendingShellChannel: '',

        /**
         * @param {string} type
         * @param {Object} [data]
         */
        handleShellMessage(type, data = {}) {
            switch (type) {
                case 'settings-state':
                    this.applyShellSettings(data);
                    return;
                case 'set-theme':
                    if (data.theme === 'dark' || data.theme === 'light') this.applyTheme(data.theme);
                    return;
                case 'open-settings':
                    this.openSettings(typeof data.section === 'string' ? data.section : null);
                    return;
                case 'tab-activated':
                    if (this.sidebarMode === 'channels') this.markCurrentChannelAsRead();
                    this.scrollToBottom?.();
                    return;
                case 'set-playing':
                    this.setOwnPlaying(typeof data.playing === 'string' ? data.playing : '');
                    return;
                case 'open-channel':
                    this.openChannelFromShell(data.channel);
                    return;
                case 'app-resumed':
                    this.socket?.resume?.();
                    return;
                default:
                    this.callModuleHook('shellMessage', type, data);
            }
        },

        /** An irc:// link for this connection: show the channel, join it first if needed. */
        openChannelFromShell(name) {
            const channel = normalizeChannelName(name);
            if (!channel) return;
            if (!this.isRegistered) {
                this._pendingShellChannel = channel;
                return;
            }
            if (this.availableChannels.includes(channel)) this.switchChannel(channel);
            else this.joinChannel(channel);
        },

        /** After the registration: the channel of a link that came in while connecting. */
        joinPendingShellChannel() {
            const channel = this._pendingShellChannel;
            this._pendingShellChannel = '';
            if (channel) this.openChannelFromShell(channel);
        },
    };
}
