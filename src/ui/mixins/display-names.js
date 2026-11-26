/**
 * Display Names Mixin
 * Names the users choose themselves (IRCv3 metadata key "display-name"). They are shown
 * in messages, the nick list and DMs. The nick stays the address: mentions, completion,
 * commands and DMs use it, and it is shown next to a display name in messages and in the
 * profile card, so a display name never hides who wrote something.
 *
 * The own name is kept per connection (preferences) and published on connect. The server
 * value wins: another device of the same account may have changed it meanwhile.
 */

export const DISPLAY_NAME_KEY = 'display-name';
export const DISPLAY_NAME_MAX_LENGTH = 32;

/** One line of plain text: control characters and invisible direction marks are dropped. */
export function normalizeDisplayName(value) {
    const text = String(value ?? '')
        .replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return Array.from(text).slice(0, DISPLAY_NAME_MAX_LENGTH).join('').trim();
}

function lower(nick) {
    return String(nick ?? '').toLowerCase();
}

export function displayNamesMixin() {
    return {
        userDisplayNames: {},
        displayNameDraft: '',
        displayNameMaxLength: DISPLAY_NAME_MAX_LENGTH,
        _ownDisplayNameCheck: false,

        /** The display name of a nick, '' when none is set or it only repeats the nick. */
        displayName(nick) {
            const name = this.userDisplayNames[lower(nick)] || '';
            return name && lower(name) !== lower(nick) ? name : '';
        },

        /** What to show for a nick: its display name, or the nick itself. */
        shownName(nick) {
            return this.displayName(nick) || nick || '';
        },

        /** "Name (nick)" with a display name, otherwise just the nick (titles, tooltips). */
        nameWithNick(nick) {
            const name = this.displayName(nick);
            return name ? `${name} (${nick})` : (nick || '');
        },

        setUserDisplayName(nick, value) {
            const key = lower(nick);
            if (!key) return;
            const name = normalizeDisplayName(value);
            if (name) this.userDisplayNames[key] = name;
            else delete this.userDisplayNames[key];
        },

        renameUserDisplayName(oldNick, newNick) {
            const name = this.userDisplayNames[lower(oldNick)];
            this.setUserDisplayName(oldNick, '');
            if (name) this.setUserDisplayName(newNick, name);
        },

        /**
         * Set (or with '' remove) the own display name and publish it.
         * Returns the stored value.
         */
        changeOwnDisplayName(value) {
            this.setOwnDisplayName(value);
            this.publishOwnDisplayName();
            return this.ownDisplayName;
        },

        /** Publish the own value; empty removes the key on the server. */
        publishOwnDisplayName() {
            this.setUserDisplayName(this.nickname, this.ownDisplayName);
            if (!this.supportsMetadata || !this.canSendChat()) return;
            this.sendRaw(this.ownDisplayName
                ? `METADATA * SET ${DISPLAY_NAME_KEY} :${this.ownDisplayName}`
                : `METADATA * SET ${DISPLAY_NAME_KEY}`);
        },

        /** After connecting: ask the server first, the answer decides (ownDisplayNameChanged). */
        checkOwnDisplayName() {
            if (!this.supportsMetadata || !this.canSendChat()) return;
            this._ownDisplayNameCheck = true;
            this.sendRaw(`METADATA ${this.nickname} GET ${DISPLAY_NAME_KEY}`);
        },

        /**
         * The server reported the own value. A value there is taken over (set on another
         * device). Nothing there after connecting: this device's value is published.
         */
        ownDisplayNameChanged(value) {
            const name = normalizeDisplayName(value);
            if (this._ownDisplayNameCheck) {
                this._ownDisplayNameCheck = false;
                if (!name && this.ownDisplayName) {
                    this.publishOwnDisplayName();
                    return;
                }
            }
            if (name !== this.ownDisplayName) this.setOwnDisplayName(name);
        },

        /** Save from the field in the own profile card. */
        saveDisplayNameDraft() {
            this.changeOwnDisplayName(this.displayNameDraft);
            this.displayNameDraft = this.ownDisplayName;
        },
    };
}
