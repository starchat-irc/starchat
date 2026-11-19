/**
 * Bots Mixin
 * Marks bots behind their name (messages, user list, DMs) using the IRCv3 bot mode:
 *  - ISUPPORT BOT=<mode> names the user mode that marks bots,
 *  - every message of a bot carries the "bot" tag,
 *  - WHO replies list the bot mode in the flags.
 * Network services (NickServ, ChanServ, ...) get the same badge.
 */
import { isServiceNick } from '../../core/services.js';

export function botsMixin() {
    return {
        /** { nick (lower case): true } learned from tags and WHO */
        botNicks: {},
        /** User mode for bots from ISUPPORT BOT=, '' when the server has none */
        botModeChar: '',

        isBotNick(nick) {
            if (!nick) return false;
            return Boolean(this.botNicks[String(nick).toLowerCase()]) || isServiceNick(nick);
        },

        botBadgeTitle(nick) {
            return isServiceNick(nick) ? this.t('bot_title_service') : this.t('bot_title');
        },

        markBot(nick, isBot) {
            const key = String(nick || '').toLowerCase();
            if (!key || Boolean(this.botNicks[key]) === Boolean(isBot)) return;
            const next = { ...this.botNicks };
            if (isBot) next[key] = true;
            else delete next[key];
            this.botNicks = next;
        },

        /** Any line from a bot carries the "bot" tag (IRCv3 bot mode). */
        noteBotTag(msg) {
            if (msg?.nick && msg.tags && Object.prototype.hasOwnProperty.call(msg.tags, 'bot')) this.markBot(msg.nick, true);
        },

        /** WHO flags ("H", "G@", "HB" ...): only meaningful when the server announced a bot mode. */
        noteWhoFlags(nick, flags) {
            if (!this.botModeChar) return;
            this.markBot(nick, String(flags || '').includes(this.botModeChar));
        },

        renameBot(oldNick, newNick) {
            const key = String(oldNick || '').toLowerCase();
            if (!this.botNicks[key]) return;
            this.markBot(oldNick, false);
            this.markBot(newNick, true);
        },
    };
}
