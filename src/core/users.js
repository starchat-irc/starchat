const PREFIX_PATTERN = /^[~&@%+]/;
const rolePriority = { '~': 1, '&': 2, '@': 3, '%': 4, '+': 5, '': 6 };
const roleOrder = ['~', '&', '@', '%', '+'];

/** Values some clients and bots send for "nothing" in the playing metadata. */
const EMPTY_PLAYING_VALUES = ['*', '-', 'none', 'null', 'undefined', '(none)', 'N/A'];

function compareUsers(a, b) {
    return rolePriority[a.role] - rolePriority[b.role] || a.name.localeCompare(b.name);
}

function createUser(name, { role = '', account = null, realname = '' } = {}) {
    return {
        role,
        prefixModes: role ? [role] : [],
        name,
        isTyping: false,
        isAway: false,
        isOnline: true,
        account,
        realname,
        playing: '',
        voice: '',
    };
}

/**
 * Nick lists per channel with prefix modes, away, typing and metadata state.
 * Every change replaces the channel's array so reactive UIs see it.
 *
 * @param {import('./store.js').StateStore} store
 */
export function UserManager(store) {
    store.set({});

    return {
        ensureChannel(channel) {
            if (!Array.isArray(store.get()[channel])) {
                store.get()[channel] = [];
            }
        },

        flush(channel) {
            store.get()[channel] = [...store.get()[channel]];
        },

        clear(channel) {
            store.get()[channel] = [];
        },

        clearAll() {
            store.set({});
        },

        get(channel) {
            return store.get()[channel] || [];
        },

        getUser(channel, name) {
            return this.get(channel).find((u) => u.name === name);
        },

        /** Merge a NAMES reply ("@op", "+voice", "plain") into the channel. */
        updateUserList(channel, userList) {
            this.ensureChannel(channel);
            const existing = store.get()[channel];

            userList.forEach((user) => {
                const role = PREFIX_PATTERN.test(user) ? user[0] : '';
                const name = user.replace(PREFIX_PATTERN, '');
                const found = existing.find((u) => u.name === name);
                if (found) {
                    if (role) { found.role = role; found.prefixModes = [role]; }
                } else {
                    existing.push(createUser(name, { role }));
                }
            });
        },

        updateUserRole(channel, name, role, add) {
            this.ensureChannel(channel);
            const user = this.getUser(channel, name);
            if (user) {
                if (!Array.isArray(user.prefixModes)) {
                    user.prefixModes = user.role ? [user.role] : [];
                }
                if (add) {
                    if (!user.prefixModes.includes(role)) user.prefixModes.push(role);
                } else {
                    user.prefixModes = user.prefixModes.filter((prefix) => prefix !== role);
                }
                user.role = roleOrder.find((prefix) => user.prefixModes.includes(prefix)) || '';
                this.flush(channel);
            }
        },

        addUser(channel, name, account = null, realname = '') {
            this.ensureChannel(channel);
            const existing = this.getUser(channel, name);
            if (!existing) {
                store.get()[channel].push(createUser(name, { account, realname }));
            } else {
                Object.assign(existing, { account, realname });
            }

            this.flush(channel);
        },

        removeUser(channel, name) {
            this.ensureChannel(channel);
            store.get()[channel] = this.get(channel).filter((u) => u.name !== name);
            this.flush(channel);
        },

        renameUser(oldName, newName) {
            this.updateEverywhere(oldName, (user) => { user.name = newName; });
        },

        setTyping(channel, name, isTyping) {
            this.ensureChannel(channel);
            const user = this.getUser(channel, name);
            if (user) {
                user.isTyping = isTyping;
                this.flush(channel);
            }
        },

        setAway(name, isAway) {
            this.updateEverywhere(name, (user) => { user.isAway = isAway; });
        },

        setPlaying(name, playing) {
            const nextRaw = typeof playing === 'string' ? playing.trim() : '';
            const next = EMPTY_PLAYING_VALUES.includes(nextRaw) ? '' : nextRaw;
            this.updateEverywhere(name, (user) => { user.playing = next; });
        },

        /** Channel whose voice chat the user is in (IRC metadata "voice"), '' for none. */
        setVoice(name, channel) {
            const next = typeof channel === 'string' && channel.trim().startsWith('#') ? channel.trim().toLowerCase() : '';
            this.updateEverywhere(name, (user) => {
                if ((user.voice || '') === next) return false;
                user.voice = next;
            });
        },

        clearPlaying(name) {
            this.setPlaying(name, '');
        },

        setOnline(name, isOnline) {
            this.updateEverywhere(name, (user) => { user.isOnline = isOnline; });
        },

        /**
         * Apply a change to the user in every channel. The callback returns false
         * when nothing changed, the channel is then not flushed.
         */
        updateEverywhere(name, change) {
            Object.keys(store.get()).forEach((channel) => {
                const user = this.getUser(channel, name);
                if (user && change(user) !== false) {
                    this.flush(channel);
                }
            });
        },

        sort(channel) {
            this.ensureChannel(channel);
            if (this.get(channel).length > 0) {
                store.get()[channel].sort(compareUsers);
                this.flush(channel);
            }
        },

        getSorted(channel) {
            this.ensureChannel(channel);
            return [...this.get(channel)].sort(compareUsers);
        },
    };
}
