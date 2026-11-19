/**
 * Pages of the network from its discovery file (links): registration, channel invites,
 * report policy. Networks without them show none of these links.
 */
import { CHANNEL_PLACEHOLDER } from '../../core/discovery.js';
import { copyText } from '../clipboard.js';

/** Letters and digits of any script: Ergo allows channels such as #schimäre. */
const INVITE_CHANNEL = /^[\p{L}\p{N}_-]+$/u;

export function networkLinksMixin() {
    return {
        networkLink(name) {
            return this.connection?.links?.[name] || '';
        },

        /** Only for the connection the dialog would use: another server has its own pages. */
        registerUrl() {
            if (this.selectedServerId && this.selectedServerId !== this.connection?.server?.id) return '';
            return this.networkLink('register');
        },

        channelInviteUrl(channel) {
            const template = this.networkLink('channelInvite');
            const bare = String(channel || '').trim().replace(/^#+/, '');
            if (!template || !INVITE_CHANNEL.test(bare)) return null;
            return template.replace(CHANNEL_PLACEHOLDER, encodeURIComponent(bare));
        },

        async copyInviteLink(url) {
            if (this.contextMenu) this.contextMenu.show = false;
            if (!url) return;
            const copied = await copyText(url);
            this.updateStatus(this.t(copied ? 'invite_link_copied' : 'invite_link_copy_failed'));
        },
    };
}
