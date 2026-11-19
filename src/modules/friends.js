/**
 * Friends module (feature "friends")
 * Friend list and requests from the server's API, presence over IRC (MONITOR, JOIN,
 * QUIT, AWAY). DMs with friends get their own section in the sidebar. API: docs/discovery.md.
 *
 * Friends are keyed by `user.display`, the nick the other side uses on IRC.
 */

const POLL_INTERVAL_MS = 10000;
const MONITOR_CHUNK_SIZE = 20;

/** Notice after a successful action, by action name. */
const ACTION_NOTICES = {
    accept: 'friends_accepted',
    decline: 'friends_declined',
    block: 'friends_blocked',
    unfriend: 'friends_removed',
};

function list(value) {
    return Array.isArray(value) ? value.filter(entry => entry && typeof entry.user?.display === 'string' && entry.user.display) : [];
}

/** The friends answer with every list present, entries without a nick dropped. */
export function normalizeFriends(data) {
    return {
        friends: list(data?.friends),
        incoming: list(data?.incoming_requests),
        outgoing: list(data?.outgoing_requests),
        blocked: list(data?.blocked),
    };
}

function lower(value) {
    return String(value || '').toLowerCase();
}

function displayOf(entry) {
    return entry.user?.display || '';
}

/** First validation message of a Laravel style error answer. */
function errorMessage(data, fallback) {
    return Object.values(data?.errors || {})[0]?.[0] || data?.message || fallback;
}

export function friendsMixin() {
    return {
        friends: [],
        incomingFriendRequests: [],
        outgoingFriendRequests: [],
        blockedFriends: [],
        friendFilter: 'online', // hub tab: 'online' | 'all' | 'pending'
        friendSearch: '',
        friendRequestInput: '',
        friendNotice: '',
        friendPresence: {},
        _friendPollTimer: null,

        /** Friends need the feature and a token of this connection; guests have none. */
        canUseFriends() {
            return this.hasFeature('friends') && this.hasApiToken;
        },

        startFriendPolling() {
            this.stopFriendPolling();
            if (!this.canUseFriends()) return;
            this._friendPollTimer = setInterval(() => this.fetchFriends(), POLL_INTERVAL_MS);
        },

        stopFriendPolling() {
            if (this._friendPollTimer) clearInterval(this._friendPollTimer);
            this._friendPollTimer = null;
        },

        clearFriends() {
            this.friends = [];
            this.incomingFriendRequests = [];
            this.outgoingFriendRequests = [];
            this.blockedFriends = [];
            this.friendPresence = {};
        },

        async fetchFriends() {
            if (!this.canUseFriends()) {
                this.stopFriendPolling();
                this.clearFriends();
                return;
            }
            try {
                const response = await this.connection.api('friends');
                if (response.status === 401) {
                    // Token expired: the next registration starts over
                    this.stopFriendPolling();
                    return;
                }
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = normalizeFriends(await response.json());

                const before = this.friends.map(displayOf).sort().join(',');
                this.friends = data.friends;
                this.incomingFriendRequests = data.incoming;
                this.outgoingFriendRequests = data.outgoing;
                this.blockedFriends = data.blocked;
                if (this.friends.map(displayOf).sort().join(',') !== before) this.syncFriendMonitor();
            } catch (error) {
                // Unreachable API: no retry every few seconds, the next registration tries again
                if (error instanceof TypeError) this.stopFriendPolling();
                console.warn('Could not load friends:', error);
            }
        },

        async sendFriendRequest() {
            const nick = this.friendRequestInput.trim();
            if (!nick || !this.canUseFriends()) return;
            try {
                const response = await this.connection.api('friends/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nick }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(errorMessage(data, this.t('friends_action_failed')));
                this.friendNotice = this.t(data.auto_accepted ? 'friends_accepted' : 'friends_request_sent');
                this.friendRequestInput = '';
                await this.fetchFriends();
            } catch (error) {
                this.friendNotice = error.message || this.t('friends_action_failed');
            }
        },

        /** @param {'accept'|'decline'|'block'|'unfriend'} action */
        async friendAction(friendshipId, action) {
            if (!ACTION_NOTICES[action] || !this.canUseFriends()) return;
            const id = encodeURIComponent(friendshipId);
            const [method, path] = action === 'unfriend' ? ['DELETE', `friends/${id}`] : ['POST', `friends/${id}/${action}`];
            try {
                const response = await this.connection.api(path, { method });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(errorMessage(data, this.t('friends_action_failed')));
                this.friendNotice = this.t(ACTION_NOTICES[action]);
                await this.fetchFriends();
            } catch (error) {
                this.friendNotice = error.message || this.t('friends_action_failed');
            }
        },

        // Presence

        updateFriendPresence(nick, state = 'online') {
            if (!nick || (this.friendPresence[nick] || 'offline') === state) return;
            this.friendPresence = { ...this.friendPresence, [nick]: state };
        },

        friendState(display) {
            return this.friendPresence[display] || 'offline';
        },

        isFriendOnline(display) {
            const state = this.friendState(display);
            return state === 'online' || state === 'away';
        },

        isFriendNick(nick) {
            const needle = lower(nick);
            return Boolean(needle) && this.friends.some(entry => lower(displayOf(entry)) === needle);
        },

        /** MONITOR is lost with the connection, so this runs after every registration. */
        syncFriendMonitor() {
            if (!this.isRegistered) return;
            const nicks = this.friends.map(displayOf).filter(Boolean);
            if (!nicks.length) return;
            this.sendRaw('MONITOR C');
            for (let index = 0; index < nicks.length; index += MONITOR_CHUNK_SIZE) {
                const chunk = nicks.slice(index, index + MONITOR_CHUNK_SIZE).join(',');
                this.sendRaw(`MONITOR + ${chunk}`);
                // WHOIS for the away state, MONITOR only knows online and offline
                this.sendRaw(`WHOIS ${chunk}`);
            }
        },

        // Lists

        /** Sidebar: online friends without an open DM (those are listed with the DMs). */
        onlineFriendsWithoutDm() {
            const open = new Set(this.privateMessageKeys.map(lower));
            return this.friends
                .filter(entry => this.isFriendOnline(displayOf(entry)) && !open.has(lower(displayOf(entry))))
                .sort((a, b) => displayOf(a).localeCompare(displayOf(b)));
        },

        friendTabCounts() {
            return {
                online: this.friends.filter(entry => this.isFriendOnline(displayOf(entry))).length,
                all: this.friends.length,
                pending: this.incomingFriendRequests.length + this.outgoingFriendRequests.length,
            };
        },

        /** Hub list: filtered by tab and search, online first, then alphabetical. */
        filteredFriendList() {
            const search = this.friendSearch.trim().toLowerCase();
            return this.friends
                .filter(entry => {
                    if (search && !lower(displayOf(entry)).includes(search)) return false;
                    return this.friendFilter !== 'online' || this.isFriendOnline(displayOf(entry));
                })
                .sort((a, b) => {
                    const online = Number(!this.isFriendOnline(displayOf(a))) - Number(!this.isFriendOnline(displayOf(b)));
                    return online || displayOf(a).localeCompare(displayOf(b));
                });
        },

        openFriendChat(nick) {
            this.openDirectMessage(nick);
        },

        openFriendContextMenu(friend, event) {
            this.contextMenu.show = false;
            const position = this.clampMenuPosition(event.clientX, event.clientY, 220, 120);
            this.friendContextMenu = { show: true, x: position.x, y: position.y, friendId: friend.friendship_id, friendName: displayOf(friend) };
        },

        removeFriendFromContextMenu() {
            if (!this.friendContextMenu.friendId) return;
            this.friendAction(this.friendContextMenu.friendId, 'unfriend');
            this.friendContextMenu.show = false;
        },

        // User card

        /** 'friend', 'pending' or '', matched by nick or by the account from WHOIS. */
        profileFriendStatus() {
            const nick = lower(this.selectedUser);
            const account = lower(this.profileCard?.account);
            const matches = entry => {
                const display = lower(displayOf(entry));
                return display === nick || (account && display === account);
            };
            if (this.friends.some(matches)) return 'friend';
            if ([...this.incomingFriendRequests, ...this.outgoingFriendRequests].some(matches)) return 'pending';
            return '';
        },

        /** Requests go to accounts, so users without one cannot be added. */
        canAddProfileFriend() {
            return this.canUseFriends() && Boolean(this.profileCard?.account)
                && !this.isOwnProfileCard() && this.profileFriendStatus() === '';
        },

        async addFriendFromProfileCard() {
            this.friendRequestInput = this.profileCard?.account || '';
            await this.sendFriendRequest();
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const friendsModule = {
    name: 'friends',
    mixin: friendsMixin,
    hooks: {
        /** After every registration: the list may have changed while we were away. */
        registered() {
            if (!this.canUseFriends()) return;
            this.fetchFriends().then(() => this.startFriendPolling());
        },
        loggedOut() {
            this.stopFriendPolling();
            this.clearFriends();
        },
    },
};
