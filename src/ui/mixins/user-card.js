/**
 * User Card Mixin
 * The card that opens on a click on a nick, and custom status texts (IRCv3 metadata
 * key "status").
 *
 * A nick says nothing about who is behind it, so the card asks the IRC server first
 * (silent WHOIS: account, away message, IRC operator). With the profiles module the
 * profile of that account is loaded afterwards (fetchProfileCard).
 */

/** WHOIS replies that belong to a card lookup and stay out of the server window. */
const WHOIS_NUMERICS = new Set(['276', '301', '307', '311', '312', '313', '317', '318', '319', '320', '330', '338', '378', '379', '401', '671']);
const WHOIS_TIMEOUT_MS = 5000;

export const STATUS_MAX_LENGTH = 128;

/** Statuses are one line of plain text: control characters (mIRC codes, line breaks) are dropped. */
export function normalizeStatus(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function emptyProfileCard(nick = '') {
    return {
        nick,
        account: null,
        realname: '',
        awayMessage: '',
        isOperator: false,
        isOnline: true,
        whoisDone: false,
        loading: false,
        profile: null,
    };
}

export function userCardMixin() {
    return {
        profileCard: emptyProfileCard(),
        _profileWhoisPending: new Set(),
        _profileWhoisTimers: new Map(),

        // Custom status

        userStatus(nick) {
            return this.userStatuses[String(nick || '').toLowerCase()] || '';
        },

        setUserStatus(nick, value) {
            const key = String(nick || '').toLowerCase();
            if (!key) return;
            const status = normalizeStatus(value).slice(0, STATUS_MAX_LENGTH * 2);
            if (status) {
                this.userStatuses[key] = status;
            } else {
                delete this.userStatuses[key];
            }
        },

        renameUserStatus(oldNick, newNick) {
            const status = this.userStatus(oldNick);
            this.setUserStatus(oldNick, '');
            if (status) this.setUserStatus(newNick, status);
        },

        /** Publish the own status. Re-asserted on every connect, empty removes a stale key. */
        syncOwnStatus() {
            this.setUserStatus(this.nickname, this.ownStatus);
            if (!this.supportsMetadata || !this.canSendChat()) return;
            this.sendRaw(this.ownStatus ? `METADATA * SET status :${this.ownStatus}` : 'METADATA * SET status');
        },

        // Card

        loadProfileCard(nick) {
            this.profileCard = emptyProfileCard(nick);
            if (!nick || /\s/.test(nick) || !this.isRegistered) {
                this.profileCard.whoisDone = true;
                return;
            }

            const key = nick.toLowerCase();
            this._profileWhoisPending.add(key);
            clearTimeout(this._profileWhoisTimers.get(key));
            this._profileWhoisTimers.set(key, setTimeout(() => this.finishProfileWhois(key), WHOIS_TIMEOUT_MS));
            this.sendRaw(`WHOIS ${nick}`);
        },

        /**
         * Called for every incoming line before it is logged. Returns true when the
         * line was a reply to a card lookup and needs no further handling.
         */
        consumeProfileWhois(msg) {
            if (!this._profileWhoisPending.size || !WHOIS_NUMERICS.has(msg.command)) return false;
            const key = String(msg.params[1] || '').toLowerCase();
            if (!this._profileWhoisPending.has(key)) return false;

            const card = this.profileCard.nick.toLowerCase() === key ? this.profileCard : null;
            const lastParam = msg.params[msg.params.length - 1] || '';

            switch (msg.command) {
                case '311': if (card) card.realname = lastParam; break;
                case '313': if (card) card.isOperator = true; break;
                case '330': if (card) card.account = msg.params[2] || null; break;
                case '401': if (card) card.isOnline = false; break;
                case '301':
                    this.activeUsers.setAway(msg.params[1], true);
                    if (card) card.awayMessage = lastParam;
                    break;
                case '318': this.finishProfileWhois(key); break;
            }
            return true;
        },

        finishProfileWhois(key) {
            clearTimeout(this._profileWhoisTimers.get(key));
            this._profileWhoisTimers.delete(key);
            if (!this._profileWhoisPending.delete(key)) return;

            const card = this.profileCard;
            if (card.nick.toLowerCase() !== key) return;
            card.whoisDone = true;
            if (card.account && this.hasFeature('profiles')) this.fetchProfileCard?.(card.nick, card.account);
            this.$nextTick(() => this.positionUserMenu());
        },

        profileCardAvatar() {
            return this.avatarUrl(this.selectedUser) || this.profileCardProfileAvatar?.() || '';
        },

        /** Entry of the selected user in the current channel's user list, if present. */
        profileCardUser() {
            const users = this.reactiveUsers?.[this.currentChannel] || [];
            const nick = String(this.selectedUser || '').toLowerCase();
            return users.find(user => user.name.toLowerCase() === nick) || null;
        },

        /** Live value from the server first, the saved profile status for users without metadata support. */
        profileCardStatusText() {
            return this.userStatus(this.selectedUser) || normalizeStatus(this.profileCard.profile?.status);
        },

        profileCardStatus() {
            if (!this.profileCard.isOnline) return 'offline';
            if (this.profileCard.awayMessage || this.profileCardUser()?.isAway) return 'away';
            return 'online';
        },

        profileCardRole() {
            const roles = { '~': 'Owner', '&': 'Admin', '@': 'Operator', '%': 'Half-Op', '+': 'Voice' };
            return roles[this.profileCardUser()?.role] || '';
        },

        isOwnProfileCard() {
            return String(this.selectedUser || '').toLowerCase() === String(this.nickname || '').toLowerCase();
        },
    };
}
