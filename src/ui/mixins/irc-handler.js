/**
 * IRC Handler Mixin
 * Processes every raw IRC message from the connection. Lines are parsed once
 * (irc-parser.js) and dispatched to one handler per command (COMMAND_HANDLERS).
 * Handlers are called with `this` bound to the chat component.
 *
 * Methods of feature modules (friends, voice, push, profiles, chat state) are called
 * only when the module is loaded. Messages for the app around the chat (desktop shell,
 * embedding page) go through notifyHost(type, data).
 */
import { parseIrcLine } from '../../core/irc-parser.js';
import { isServiceNick } from '../../core/services.js';
import { SERVER_WINDOW } from './server-window.js';

/** Numerics that are too noisy for the server window (automatic NAMES/WHO/list refreshes). */
// Metadata replies (760–774: values, subscriptions, sync) are handled by the chat itself. Avatars,
// status and now-playing change all the time and would flood the window.
const SERVER_WINDOW_SKIP = new Set(['331', '332', '333', '315', '352', '353', '354', '366', '367', '348', '346', '376',
    '760', '761', '762', '764', '765', '766', '767', '768', '769', '770', '771', '772', '774', '775']);

/** Channel prefix modes and their user prefix symbols. */
const PREFIX_MODES = { q: '~', a: '&', o: '@', h: '%', v: '+' };

const EMPTY_PLAYING_VALUES = ['*', '-', 'none', 'null', 'undefined', '(none)', 'N/A'];

/** Error numerics that only produce a status message. params[1] is usually the subject. */
const ERROR_NUMERICS = {
    '401': (p) => `${p[1]}: No such nick/channel`,
    '403': (p) => `${p[1]}: No such channel`,
    '404': (p) => `Cannot send to ${p[1]}`,
    '421': (p) => `Unknown command: ${p[1]}`,
    '471': (p) => `Cannot join ${p[1]}: Channel is full`,
    '473': (p) => `Cannot join ${p[1]}: Invite only`,
    '474': (p) => `Cannot join ${p[1]}: You are banned`,
    '475': (p) => `Cannot join ${p[1]}: Bad channel key`,
    '482': (p) => `You're not a channel operator on ${p[1]}`,
};

const BULK_JOIN_TIMEOUT_MS = 10000;

/** Seconds to wait before METADATA SYNC when the server names no retry time. */
const METADATA_SYNC_DEFAULT_DELAY = 10;

/** Above the server's rate limit of 2 commands per second, so syncs never hold back the history. */
const METADATA_SYNC_SPACING_MS = 600;
/** Join the lobby after this long even when the account settings have not answered. */
const LOBBY_SETTLE_TIMEOUT_MS = 8000;
/** How often a postponed (774) or rate-limited (775) METADATA command is retried before it is given up. */
const METADATA_RETRY_LIMIT = 3;
/** A refusal this long after the last retry counts as a new problem, not as the same one. */
const METADATA_RETRY_RESET_MS = 5 * 60 * 1000;
/** Own keys whose rate-limited SET is redone with the current value, not the one that was refused. */
const OWN_METADATA_SYNC = { avatar: 'syncOwnAvatar', status: 'syncOwnStatus', playing: 'syncOwnPlaying', voice: 'syncOwnVoice' };

function applyUserMetadata(chat, nick, key, rawValue) {
    if (key === 'avatar') {
        chat.setUserAvatar(nick, rawValue);
    } else if (key === 'status') {
        chat.setUserStatus(nick, rawValue);
    } else if (key === 'voice') {
        chat.activeUsers.setVoice(nick, rawValue);
        if (sameNick(nick, chat.nickname)) chat.ownVoiceMarkerChanged?.(rawValue);
    } else if (key === 'playing') {
        const value = rawValue ? normalizePlayingValue(rawValue) : '';
        value ? chat.activeUsers.setPlaying(nick, value) : chat.activeUsers.clearPlaying(nick);
    }
}

/**
 * Events replayed inside a chathistory batch (draft/event-playback). They only
 * become a line in the history. User list, channels and presence stay untouched.
 * Each returns { text, type, self? } or null when nothing should be shown;
 * self: false keeps the line even for own events.
 */
const HISTORY_EVENT_LINES = {
    JOIN: (msg, t) => ({ text: eventText(t, 'join', { nick: msg.nick, account: msg.params[1] }), type: 'join' }),
    PART: (msg, t) => ({ text: eventText(t, 'part', { nick: msg.nick }), type: 'part' }),
    QUIT: (msg, t) => ({ text: eventText(t, 'quit', { nick: msg.nick, reason: msg.params[0] }), type: 'part' }),
    KICK: (msg, t) => msg.params[1]
        ? { text: eventText(t, 'kick', { nick: msg.nick, target: msg.params[1], reason: msg.params[2] }), type: 'kick', self: false }
        : null,
    NICK: (msg, t) => msg.params[0] ? { text: eventText(t, 'nick', { nick: msg.nick, newnick: msg.params[0] }), type: 'nick', self: false } : null,
    TOPIC: (msg, t) => ({ text: eventText(t, 'topic', { nick: msg.nick, topic: msg.params[1] }), type: 'info', self: false }),
    MODE: () => null,
};

/**
 * Text of a join/part/quit/kick/nick/topic line. Reasons and topics are appended
 * after translating, so text from other users is never read as a placeholder.
 */
export function eventText(t, kind, { nick = '', account = '', target = '', newnick = '', reason = '', topic = '' } = {}) {
    const suffix = reason ? ` (${reason})` : '';
    switch (kind) {
        case 'join':
            return account && account !== '*'
                ? t('event_joined_account', { nick, account })
                : t('event_joined', { nick });
        case 'part':
            return t('event_left', { nick });
        case 'quit':
            return t('event_quit', { nick }) + suffix;
        case 'kick':
            return t('event_kicked', { target, nick }) + suffix;
        case 'nick':
            return t('event_nick', { nick, newnick });
        case 'topic':
            return `${t('event_topic', { nick })} ${topic || ''}`.trimEnd();
        default:
            return '';
    }
}

function sameNick(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function normalizePlayingValue(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    return EMPTY_PLAYING_VALUES.includes(value) ? '' : value;
}

function legacyTimestamp(ts) {
    const date = new Date(ts);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    return isToday
        ? date.toLocaleTimeString()
        : `${date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${date.toLocaleTimeString()}`;
}

function pushListEntry(list, params) {
    const mask = params[2];
    if (mask && !list.some(entry => entry.mask === mask)) {
        list.push({ mask, by: params[3] || '', at: params[4] || '' });
    }
}

const COMMAND_HANDLERS = {
    // Registration
    '001'(msg) {
        this.nickname     = msg.params[0];
        this.isRegistered = true;
        this._desiredNick = null;
        this._nickRetry   = 0;
        this.setConnectionState('connected');
        this.connectionStatus = 'Connected';

        // Fresh connection: allow history to be fetched again so the gap of a
        // disconnect is filled (duplicates are dropped by the dedup keys).
        this.historyLoadedByTarget  = {};
        this.historyLoadingByTarget = {};
        this.resetHistoryQueue();
        this._joinedChannels = new Set();
        this._pendingMetadataSync.clear();
        this._metadataSyncQueue = [];
        this.resetMetadataRetries();

        // Subscribe before joining: the server only sends the values of channel members
        // for keys that are already subscribed at JOIN time.
        if (this.supportsMetadata) {
            this.sendRaw(`METADATA * SUB ${this.metadataKeys().join(' ')}`);
        }

        // JOIN confirmations during the initial join must not auto-switch the
        // channel. The last active channel is restored once all joins are done.
        const channelsToJoin = this.channelsToJoinOnConnect();
        this._bulkJoining = (this._bulkJoining || 0) + channelsToJoin.length;
        this.scheduleBulkJoinTimeout();
        this.joinChannels(channelsToJoin);

        this.syncFriendMonitor?.();
        this.callModuleHook?.('registered');
        this.joinPendingShellChannel?.();
        this.notifyHost('update-profile-name', { nickname: this.nickname });
        this.saveShellSaslLogin?.();
        this.privateMessageKeys.forEach(nick => this.requestHistoryLatest(nick));
        if (this.supportsMetadata) {
            // Only apps with a player publish now-playing. Re-assert (or clear) it on every connect.
            if (this.publishesNowPlaying) this.syncOwnPlaying();
            this.loadOwnAvatar?.();
            // Re-assert (or clear a stale) voice marker: always-on keeps metadata across reconnects
            this.syncOwnVoice?.();
        }
        this.flushOutgoingQueue();
        // Onboarding: ask once per account whether the nick should stay online
        this.checkAlwaysOnPrompt?.();
        // Reconnect: settings may have changed on another device meanwhile (first connect: restoreChatState)
        this.refreshAccountSettings?.();
    },

    // Batches
    BATCH(msg) {
        const reference = msg.params[0] || '';
        const batchId   = reference.slice(1);

        if (reference.startsWith('+')) {
            const batchType   = msg.params[1];
            const batchTarget = msg.params[2] || null;
            if (batchType === 'chathistory') {
                this.activeBatches.add(batchId);
                if (batchTarget) this.historyBatchTargetById[batchId] = batchTarget;
            }
            if (batchType === 'draft/multiline') {
                this.multilineBatchById[batchId] = {
                    target: batchTarget,
                    source: msg.source,
                    sender: msg.nick,
                    tags: msg.tags, // batch-level tags (server-time, msgid, parent batch)
                    isNotice: false,
                    segments: [],   // { text, concat }
                };
            }
            return;
        }

        if (!reference.startsWith('-')) return;

        // Multiline batch: reassemble the collected segments into one message.
        if (this.multilineBatchById[batchId]) {
            this.assembleMultilineBatch(batchId);
            delete this.multilineBatchById[batchId];
            return;
        }

        if (!this.activeBatches.has(batchId)) return;
        this.activeBatches.delete(batchId);
        const target = this.resolveTargetKey(this.historyBatchTargetById[batchId] || this.currentChannel);
        delete this.historyBatchTargetById[batchId];
        if (target) this.finishHistoryBatch(target);
    },

    // Channel LIST
    '321'() {
        this.serverChannels = [];
        this.isListing = true;
    },
    '322'(msg) {
        const name = msg.params[1];
        if (!name || name.startsWith('&')) return;
        this.serverChannels.push({
            name,
            users: parseInt(msg.params[2], 10) || 0,
            topic: msg.params[3] || '',
        });
    },
    '323'() {
        this.isListing = false;
        this.updateStatus(`Received ${this.serverChannels.length} channels from server.`);
    },

    // Channel modes / lists
    '324'(msg) {
        const channel = (msg.params[1] || '').toLowerCase();
        if (channel !== this.currentChannel) return;
        this.stores.channelManagement.get().channelModesDraft = msg.params.slice(2).join(' ').trim();
        this.parseChannelModeState(msg.params[2] || '');
    },
    '367'(msg) {
        if ((msg.params[1] || '').toLowerCase() === this.currentChannel) pushListEntry(this.stores.channelManagement.get().banList, msg.params);
    },
    '348'(msg) {
        if ((msg.params[1] || '').toLowerCase() === this.currentChannel) pushListEntry(this.stores.channelManagement.get().exceptionList, msg.params);
    },
    '346'(msg) {
        if ((msg.params[1] || '').toLowerCase() === this.currentChannel) pushListEntry(this.stores.channelManagement.get().invexList, msg.params);
    },

    // MONITOR presence
    '730'(msg) { this.applyMonitorPresence(msg, 'online'); },
    '731'(msg) { this.applyMonitorPresence(msg, 'offline'); },

    // Topics
    '332'(msg) {
        this.channelManager.setTopic((msg.params[1] || '').toLowerCase(), msg.params[2] || '');
    },
    TOPIC(msg) {
        this.channelManager.setTopic((msg.params[0] || '').toLowerCase(), msg.params[1] || '');
    },

    // WHO / NAMES
    '352'(msg) {
        // <me> <channel> <user> <host> <server> <nick> <flags> :<hopcount> <realname>
        const channel  = (msg.params[1] || '').toLowerCase();
        const user     = msg.params[5];
        const flags    = msg.params[6] || '';
        if (!channel.startsWith('#') || !user) return;
        this.noteWhoFlags(user, flags);
        const isAway   = flags.includes('G');
        const role     = ['~', '&', '@', '%', '+'].find(r => flags.includes(r)) || '';
        const realname = (msg.params[7] || '').split(' ').slice(1).join(' ');
        this.activeUsers.addUser(channel, user, null, realname);
        this.updateFriendPresence?.(user, isAway ? 'away' : 'online');
        const entry = this.activeUsers.getUser(channel, user);
        if (entry) {
            entry.role        = role;
            entry.prefixModes = role ? [role] : [];
            entry.isAway      = isAway;
            entry.isOnline    = !isAway;
        }
        this.activeUsers.sort(channel);
    },
    '353'(msg) {
        // <me> <symbol> <channel> :<names> (may arrive in multiple messages)
        const channel = (msg.params[2] || '').toLowerCase();
        const names   = (msg.params[3] || '').split(' ').filter(Boolean);
        this.activeUsers.updateUserList(channel, names);
    },
    '366'(msg) {
        const channel = (msg.params[1] || '').toLowerCase();
        this.activeUsers.sort(channel);
        // After NAMES, so per-user values such as now-playing find their user. NAMES also
        // runs on automatic refreshes, the sync only belongs to the own JOIN.
        if (this._pendingMetadataSync.delete(channel) && this.supportsMetadata) {
            this._metadataSyncQueue.push(channel);
            this.scheduleMetadataSync();
        }
    },

    // MODE
    MODE(msg) {
        const channel = (msg.params[0] || '').toLowerCase();
        if (!channel.startsWith('#')) return; // user modes
        const modeString = msg.params[1] || '';
        let argIndex = 2;
        let op = '+';

        const modeNeedsArg = (modeChar, sign) => {
            if (['b', 'e', 'I', 'k'].includes(modeChar)) return true;
            if (['l', 'j', 'f'].includes(modeChar)) return sign === '+';
            return false;
        };

        for (const modeChar of modeString) {
            if (modeChar === '+' || modeChar === '-') {
                op = modeChar;
                continue;
            }
            if (PREFIX_MODES[modeChar]) {
                const target = msg.params[argIndex++];
                if (target) this.activeUsers.updateUserRole(channel, target, PREFIX_MODES[modeChar], op === '+');
                continue;
            }
            if (modeNeedsArg(modeChar, op)) argIndex++;
        }

        if (channel === this.currentChannel) {
            this.parseChannelModeState(modeString);
        }
        this.activeUsers.sort(channel);
    },

    // JOIN / PART / KICK / QUIT
    JOIN(msg) {
        const user    = msg.nick;
        const channel = (msg.params[0] || '').toLowerCase();
        const account = msg.params[1] && msg.params[1] !== '*' ? msg.params[1] : null;
        if (!channel) return;

        // Own JOIN (also after a reconnect): NAMES/WHO rebuild the list, so drop stale
        // entries, including now-playing values of users who changed it meanwhile.
        if (sameNick(user, this.nickname)) this.activeUsers.clear(channel);

        this.activeUsers.addUser(channel, user, account, msg.params[2] || '');
        this.updateFriendPresence?.(user, 'online');
        if (sameNick(user, this.nickname) && this._ownPlaying) this.activeUsers.setPlaying(user, this._ownPlaying);

        if (!sameNick(user, this.nickname)) {
            // The server only notifies existing members when a value changes, not on JOIN
            if (this.supportsMetadata && this.hasFeature('profiles') && !this.avatarUrl(user)) {
                this.sendRaw(`METADATA ${user} GET avatar`);
            }
            this.addSystemLine(channel, eventText(this.t, 'join', { nick: user, account }), { user, isJoinPart: true, joinPartType: 'join', tags: msg.tags });
            if (channel === this.currentChannel) this.updatePresence();
        } else {
            if (!this.availableChannels.some(c => c.toLowerCase() === channel)) {
                this.availableChannels.push(channel);
                this.scheduleChatStateSave?.();
            }
            this.availableChannels.sort();
            this._joinedChannels.add(channel);
            // Back in a lobby the user had left: it is joined automatically again from now on
            if (channel === this.lobbyChannel?.toLowerCase()) this.rememberLeftLobby(channel, false);
            this._pendingMetadataSync.add(channel);
            this.requestHistoryLatest(channel);

            if (this._bulkJoining > 0) {
                this._bulkJoining--;
                // The last active channel is there: show it now, don't wait for the other joins
                if (channel === this._pendingActiveChannel) {
                    this._pendingActiveChannel = null;
                    this.switchChannel(channel);
                }
                if (this._bulkJoining === 0) this.finishBulkJoin();
            } else if (this._requestedJoins.delete(channel)) {
                // Joined here (/join, explore, a link): show it. A JOIN from another device
                // of the same account only adds the channel to the list.
                this.switchChannel(channel);
            }
        }
        this.activeUsers.sort(channel);
    },

    PART(msg) {
        const user    = msg.nick;
        const channel = (msg.params[0] || '').toLowerCase();
        if (!sameNick(user, this.nickname)) {
            this.addSystemLine(channel, eventText(this.t, 'part', { nick: user }), { user, isJoinPart: true, joinPartType: 'part', tags: msg.tags });
        } else {
            this._joinedChannels.delete(channel);
            this.voiceChannelLeft?.(channel);
            this.forgetPartedChannel(channel);
        }
        this.activeUsers.removeUser(channel, user);
        if (!this.isUserInAnyChannel(user)) this.activeUsers.clearPlaying(user);
    },

    KICK(msg) {
        const channel = (msg.params[0] || '').toLowerCase();
        const target  = msg.params[1];
        if (!target) return;
        this.addSystemLine(channel, eventText(this.t, 'kick', { nick: msg.nick, target, reason: msg.params[2] }), { isJoinPart: true, joinPartType: 'kick', tags: msg.tags });
        this.activeUsers.removeUser(channel, target);
        this.activeUsers.sort(channel);

        if (sameNick(target, this.nickname)) {
            this._joinedChannels.delete(channel);
            this.voiceChannelLeft?.(channel);
            this.availableChannels =this.availableChannels.filter(ch => ch !== channel);
            if (this.currentChannel === channel) {
                this.switchChannel(this.availableChannels[0] || 'Server');
            }
            this.scheduleChatStateSave?.();
        }
    },

    QUIT(msg) {
        const user = msg.nick;
        const reason = msg.params[0] || '';
        Object.keys(this.reactiveUsers).forEach(channel => {
            if (!this.activeUsers.getUser(channel, user)) return;
            if (!sameNick(user, this.nickname)) {
                this.addSystemLine(channel, eventText(this.t, 'quit', { nick: user, reason }), { user, isJoinPart: true, joinPartType: 'part', tags: msg.tags });
            }
            this.activeUsers.removeUser(channel, user);
        });
        this.activeUsers.clearPlaying(user);
        this.activeUsers.setVoice(user, '');
        this.updateFriendPresence?.(user, 'offline');
    },

    // ISUPPORT
    '005'(msg) {
        for (const token of msg.params.slice(1, msg.hasTrailing ? -1 : undefined)) {
            if (token.startsWith('CLIENTTAGDENY=')) this.applyClientTagDeny(token.slice('CLIENTTAGDENY='.length));
            if (token.startsWith('VAPID=')) this.applyVapidKey?.(token.slice('VAPID='.length));
            // IRCv3 bot mode: the user mode that marks bots (usually B)
            if (token.startsWith('BOT=')) this.botModeChar = token.slice('BOT='.length).charAt(0);
        }
    },

    // Message redaction (draft/message-redaction)
    REDACT(msg) { this.handleRedact(msg); },

    // Read marker (draft/read-marker)
    MARKREAD(msg) { this.applyReadMarker(msg.params[0], msg.params[1]); },

    // Nick handling
    FAIL(msg) {
        if (msg.params[0] === 'REDACT') {
            this.handleRedactFailure(msg);
            return;
        }
        if (msg.params[0] === 'WEBPUSH') {
            this.addToServerWindow?.(`Push: ${msg.params.at(-1)}`);
            return;
        }
        if (msg.params.includes('NICKNAME_RESERVED')) {
            this.updateStatus(this.t('nick_reserved'));
        }
    },
    '400'() {
        this.updateStatus(this.t('nick_must_match_account'));
    },
    '432'(msg) {
        this.updateStatus(this.t('nick_invalid', { nick: msg.params[1] || '' }));
    },
    '433'(msg) {
        const attempted = msg.params[1] || this.nickname;
        this._desiredNick = this._desiredNick || attempted;
        this._nickRetry   = (this._nickRetry || 0) + 1;
        if (this._nickRetry > 5) {
            this.updateStatus(`Nickname ${this._desiredNick} is in use.`);
            return;
        }
        const next = `${this._desiredNick}${this._nickRetry === 1 ? '_' : this._nickRetry}`;
        this.sendRaw(`NICK ${next}`);
        this.updateStatus(`Nickname ${attempted} is in use, trying ${next}...`);
    },
    NICK(msg) {
        const oldName = msg.nick;
        const newName = msg.params[0];
        if (!newName) return;

        Object.keys(this.reactiveUsers)
            .filter(channel => this.activeUsers.getUser(channel, oldName))
            .forEach(channel => this.addSystemLine(channel, eventText(this.t, 'nick', { nick: oldName, newnick: newName }), { joinPartType: 'nick', tags: msg.tags }));

        this.activeUsers.renameUser(oldName, newName);
        this.renameBot(oldName, newName);
        this.renameUserAvatar(oldName, newName);
        this.renameUserStatus?.(oldName, newName);
        if (sameNick(oldName, this.nickname)) {
            this.nickname = newName;
            this.updateStatus(`Nickname changed to ${newName}`);
            this.notifyHost('update-profile-name', { nickname: newName });
        }
    },

    // Away
    AWAY(msg) {
        const isAway = msg.params.length > 0;
        this.activeUsers.setAway(msg.nick, isAway);
        this.activeUsers.setOnline(msg.nick, !isAway);
        this.updateFriendPresence?.(msg.nick, isAway ? 'away' : 'online');
    },
    '301'(msg) { this.activeUsers.setAway(msg.params[1], true); },
    '305'() { this.activeUsers.setAway(this.nickname, false); },
    '306'() { this.activeUsers.setAway(this.nickname, true); },

    // Metadata (draft/metadata-3, draft/metadata-2)
    '761'(msg) {
        // <me> <target> <key> <visibility> :<value>. A reply, and with metadata-3 also the live change
        const target = msg.params[1] || '';
        const key    = (msg.params[2] || '').toLowerCase();
        // Channel metadata is not used (metadata-3 includes it in the join sync)
        if (!target || target === '*' || target.startsWith('#')) return;
        // Position, not hasTrailing: the colon is only sent when the value needs it
        applyUserMetadata(this, target, key, msg.params[4] ?? '');
    },
    '766'(msg) {
        // <me> <target> <key> :Key not set. With metadata-3 also "the key was removed"
        const target = msg.params[1] || '';
        if (target && !target.startsWith('#')) applyUserMetadata(this, target, (msg.params[2] || '').toLowerCase(), '');
    },
    '774'(msg) {
        // <me> <target> <retry seconds>: the server sends the sync later on request.
        // metadata-3: target "*" stands for everything visible (METADATA *ALL SYNC).
        let target = msg.params[1] || '';
        if (!target) return;
        if (target === '*' && this.metadataVersion >= 3) target = '*ALL';
        const retryAfter = parseInt(msg.params[2], 10);
        this.scheduleMetadataRetry(`SYNC ${target}`, Number.isNaN(retryAfter) ? METADATA_SYNC_DEFAULT_DELAY : retryAfter,
            () => this.sendRaw(`METADATA ${target} SYNC`));
    },
    '775'(msg) {
        // ERR_METADATARATELIMIT (metadata-3): <me> <retry seconds> <target> <subcommand> [<params> ...]
        const retryAfter = parseInt(msg.params[1], 10);
        const target     = msg.params[2] || '';
        const subcommand = (msg.params[3] || '').toUpperCase();
        const params     = msg.params.slice(4);
        if (!target || !subcommand) return;
        const delay = Number.isNaN(retryAfter) ? METADATA_SYNC_DEFAULT_DELAY : retryAfter;

        const ownKey = (params[0] || '').toLowerCase();
        const isOwnSet = (subcommand === 'SET' || subcommand === 'CLEAR')
            && (target === '*' || sameNick(target, this.nickname)) && OWN_METADATA_SYNC[ownKey];
        if (isOwnSet) {
            // The value may have changed meanwhile: publish the current one, not the refused one
            this.scheduleMetadataRetry(`SET ${ownKey}`, delay, () => this[OWN_METADATA_SYNC[ownKey]]?.());
            return;
        }
        const last = params.length ? params[params.length - 1] : null;
        const needsTrailing = last !== null && (last === '' || last.includes(' ') || last.startsWith(':'));
        const middle = needsTrailing ? params.slice(0, -1) : params;
        const line = ['METADATA', target, subcommand, ...middle].join(' ') + (needsTrailing ? ` :${last}` : '');
        this.scheduleMetadataRetry(`${subcommand} ${target} ${params.join(' ')}`, delay, () => this.sendRaw(line));
    },
    METADATA(msg) {
        // draft/metadata-2 only: metadata-3 announces changes with 761/766
        // <target> <key> <visibility> :<value>
        const target = msg.params[0] || '';
        const key    = (msg.params[1] || '').toLowerCase();
        const value  = msg.params[3] ?? '';

        let nick = '';
        if (msg.nick && !msg.fromServer) {
            nick = msg.nick;
        } else if (target && target !== '*' && !target.startsWith('#')) {
            nick = target;
        }
        if (!nick) return;
        applyUserMetadata(this, nick, key, value);
    },

    // Typing (TAGMSG)
    TAGMSG(msg) {
        const sender      = msg.nick;
        const rawTarget   = msg.params[0] || '';
        const fromMe      = sameNick(sender, this.nickname);
        // Channel: channel window. To me: the sender's DM. Own TAGMSG to a nick (echo): that DM
        const target      = this.resolveTargetKey(rawTarget.startsWith('#') || fromMe ? rawTarget : sender);
        if (this.handleReactionTag(msg, target)) return;
        if (this.handleCallTag?.(msg, fromMe)) return;

        const typingState = msg.tags['+typing'];
        if (!sender || !typingState || fromMe) return;
        if (msg.tags.batch && this.activeBatches.has(msg.tags.batch)) return;

        const timerKey = `${target}|${sender}`;
        clearTimeout(this._typingTimers.get(timerKey));
        if (typingState === 'active') {
            this.activeUsers.setTyping(target, sender, true);
            this._typingTimers.set(timerKey, setTimeout(() => {
                this.activeUsers.setTyping(target, sender, false);
                this._typingTimers.delete(timerKey);
            }, 6000));
        } else if (typingState === 'done' || typingState === 'paused') {
            this._typingTimers.delete(timerKey);
            this.activeUsers.setTyping(target, sender, false);
        }
    },

    // Messages
    PRIVMSG(msg) { this.handleChatMessage(msg, false); },
    NOTICE(msg) { this.handleChatMessage(msg, true); },
};

export function ircHandlerMixin() {
    return {
        _typingTimers: new Map(),
        _pendingMetadataSync: new Set(),
        _metadataSyncQueue: [],
        _metadataSyncTimer: null,
        _metadataRetries: new Map(),
        _lobbyJoinDeferred: false,
        _lobbySettled: false,

        /**
         * Metadata keys subscribed after registration. Avatars and voice markers only come
         * from servers that offer the feature, other avatar URLs would be foreign hosts.
         */
        metadataKeys() {
            return [
                'playing', 'status',
                ...(this.hasFeature('profiles') ? ['avatar'] : []),
                ...(this.hasFeature('voice') ? ['voice'] : []),
            ];
        },

        /**
         * Channels joined after registration. The lobby is left out when the user left it on
         * purpose and, until the account settings have loaded, when that is not known yet:
         * joining and leaving it again on every connect would show up in the lobby.
         */
        channelsToJoinOnConnect() {
            // Autojoin channels (own list) come on top of the last session's channels
            const autojoin = (this.autojoinChannels || []).filter(channel => !this.availableChannels.includes(channel));
            this.availableChannels = [...this.availableChannels, ...autojoin];

            const lobby = this.lobbyChannel;
            // An autojoin list naming the lobby wins over having left it
            if (lobby && this.autojoinChannels?.includes(lobby)) return [...this.availableChannels];
            if (!lobby || !this.availableChannels.includes(lobby)) return [...this.availableChannels];

            if (this.hasLeftLobby(lobby)) {
                this.dropLeftLobby();
                return [...this.availableChannels];
            }
            if (this.syncsWithAccount?.() && !this._lobbySettled) {
                this._lobbyJoinDeferred = true;
                clearTimeout(this._lobbySettleTimer);
                // The chat state does not answer: join the lobby anyway rather than never
                this._lobbySettleTimer = setTimeout(() => this.settleLobby(), LOBBY_SETTLE_TIMEOUT_MS);
                return this.availableChannels.filter(channel => channel !== lobby);
            }
            return [...this.availableChannels];
        },

        /**
         * The account settings are known (or could not be loaded): leave out a lobby the user
         * left, join it if the connect had held it back.
         */
        settleLobby() {
            this._lobbySettled = true;
            clearTimeout(this._lobbySettleTimer);
            this.joinMissingAutojoinChannels();
            const lobby = this.lobbyChannel;
            const deferred = this._lobbyJoinDeferred;
            this._lobbyJoinDeferred = false;
            if (!lobby) return;

            if (this.hasLeftLobby(lobby) && !this.autojoinChannels?.includes(lobby)) {
                if (!this._joinedChannels?.has(lobby)) this.dropLeftLobby();
                return;
            }
            if (deferred && this.isRegistered && !this._joinedChannels?.has(lobby)) this.joinChannels([lobby]);
        },

        /**
         * Join autojoin channels that are not open yet, after the account settings arrived
         * (the list may come from another device) or when the user added some.
         */
        joinMissingAutojoinChannels() {
            if (!this.isRegistered) return;
            const missing = (this.autojoinChannels || []).filter(channel =>
                !this._joinedChannels?.has(channel) && !this.availableChannels.includes(channel));
            if (!missing.length) return;
            this.availableChannels = [...this.availableChannels, ...missing];
            this.joinChannels(missing);
        },

        /** Take a left lobby out of the channel list (it was only there as the default). */
        dropLeftLobby() {
            const lobby = this.lobbyChannel;
            this.availableChannels = this.availableChannels.filter(channel => channel !== lobby);
            if (this.currentChannel === lobby) {
                const next = this.availableChannels.find(channel => channel.startsWith('#'));
                if (next) this.switchChannel(next);
                else this.currentChannel = null;
            }
        },

        /**
         * Run a METADATA command again after the server's wait time (774 sync later, 775 rate limit).
         * The same command is pending only once and is given up after a few attempts in a row;
         * a refusal long after the last retry starts counting again.
         */
        scheduleMetadataRetry(retryKey, delaySeconds, send) {
            const entry = this._metadataRetries.get(retryKey) || { attempts: 0, timer: null, sentAt: 0 };
            if (entry.timer) return;
            if (Date.now() - entry.sentAt > METADATA_RETRY_RESET_MS) entry.attempts = 0;
            if (entry.attempts >= METADATA_RETRY_LIMIT) return;
            entry.attempts++;
            entry.timer = setTimeout(() => {
                entry.timer = null;
                entry.sentAt = Date.now();
                if (this.supportsMetadata && this.canSendChat()) send();
            }, Math.max(0, delaySeconds) * 1000);
            this._metadataRetries.set(retryKey, entry);
        },

        /** New connection: pending retries belong to the old one. */
        resetMetadataRetries() {
            this._metadataRetries.forEach((entry) => clearTimeout(entry.timer));
            this._metadataRetries = new Map();
        },

        scheduleMetadataSync() {
            if (this._metadataSyncTimer || !this._metadataSyncQueue.length) return;
            this._metadataSyncTimer = setTimeout(() => {
                this._metadataSyncTimer = null;
                this.sendNextMetadataSync();
                this.scheduleMetadataSync();
            }, METADATA_SYNC_SPACING_MS);
        },

        /**
         * Background work: one channel at a time, the one on screen first.
         */
        sendNextMetadataSync() {
            const activeIndex = this._metadataSyncQueue.indexOf(this.currentChannel);
            const [channel] = this._metadataSyncQueue.splice(Math.max(activeIndex, 0), 1);
            if (channel && this.canSendChat()) this.sendRaw(`METADATA ${channel} SYNC`);
        },

        handleMessage(event) {
            const msg = parseIrcLine(String(event.data || '').trim());
            if (!msg.command) return;

            if (msg.command === 'PING') {
                this.sendRaw(`PONG :${msg.params[0] || ''}`);
                return;
            }

            this.noteBotTag(msg);

            // Clearing an unset key is expected: own metadata is re-asserted on every connect
            if (msg.command === 'FAIL' && msg.params[0] === 'METADATA' && msg.params[1] === 'KEY_NOT_SET') return;

            // Metadata changes of others (avatar, status, now playing) are not for the server window.
            // Real errors (FAIL METADATA ...) still show up there.
            const isMetadataLine = msg.command === 'METADATA';

            // Silent WHOIS of the profile card
            if (this.consumeProfileWhois?.(msg)) return;

            if (!isMetadataLine) this.logServerLine(msg, SERVER_WINDOW_SKIP);

            const errorText = ERROR_NUMERICS[msg.command];
            if (errorText) {
                this.updateStatus(errorText(msg.params));
                return;
            }

            if (HISTORY_EVENT_LINES[msg.command] && this.activeBatches.has(msg.tags.batch)) {
                this.handleHistoryEvent(msg);
                return;
            }

            COMMAND_HANDLERS[msg.command]?.call(this, msg);
        },

        /**
         * JOIN/PART/QUIT/... from a chathistory batch: buffer a status line with the
         * original time, nothing else. QUIT/NICK carry no channel, the batch target is used.
         */
        handleHistoryEvent(msg) {
            const batchId = msg.tags.batch;
            const target  = this.resolveTargetKey(this.historyBatchTargetById[batchId] || msg.params[0]);
            if (!target) return;
            this.updateHistoryCursor(target, msg.tags);

            const line = HISTORY_EVENT_LINES[msg.command](msg, this.t);
            // Own joins/parts are not shown live either
            if (!line || (line.self !== false && sameNick(msg.nick, this.nickname))) return;
            if (this.isSystemLineSeen(target, msg.tags)) return;

            const parsedTs = msg.tags.time ? Date.parse(msg.tags.time) : NaN;
            const ts       = Number.isFinite(parsedTs) ? parsedTs : Date.now();
            this.messageManager.bufferAdd(target, {
                user: msg.nick || 'System', text: line.text,
                isAction: true, isJoinPart: true, isSystem: true, isHistorical: true,
                joinPartType: line.type,
                msgid: msg.tags.msgid || null,
                timestamp: legacyTimestamp(ts), _ts: ts,
            });
        },

        /**
         * Remember a status line by its msgid; true if it was already shown
         * (live event that is replayed again by the history after a reconnect).
         */
        isSystemLineSeen(target, tags) {
            if (!tags?.msgid) return false;
            const seen = this.ensureSeenMessageBucket(target);
            const key  = this.getMessageDedupKey(target, '', '', false, tags);
            if (seen.has(key)) return true;
            seen.add(key);
            return false;
        },

        /**
         * Map an IRC target to the key used in the message store:
         * channels are lower-cased, DM targets reuse an existing window regardless of casing.
         */
        resolveTargetKey(name) {
            if (!name) return name;
            if (name.startsWith('#')) return name.toLowerCase();
            if (name === SERVER_WINDOW) return name;
            const existing = this.messageManager.keys().find(
                key => !key.startsWith('#') && key.toLowerCase() === name.toLowerCase()
            );
            return existing || name;
        },

        /**
         * Whether a DM window with the nick is open.
         */
        hasOpenQuery(nick) {
            return this.messageManager.keys().some(key => sameNick(key, nick));
        },

        isUserInAnyChannel(user) {
            return Object.keys(this.reactiveUsers).some(channel => this.activeUsers.getUser(channel, user));
        },

        applyMonitorPresence(msg, state) {
            const payload = msg.params[msg.params.length - 1] || '';
            payload.split(',').forEach(entry => {
                const nick = entry.split('!')[0].trim();
                if (nick) this.updateFriendPresence?.(nick, state);
            });
        },

        /**
         * Add a status line (join/part/kick/nick) to a target. These never count as unread.
         */
        addSystemLine(target, text, { user = 'System', isJoinPart = false, joinPartType = 'info', tags = null } = {}) {
            if (!target) return;
            if (this.isSystemLineSeen(target, tags)) return;
            this.messageManager.add(target, {
                user, text,
                isAction: true, isJoinPart: true, isSystem: true,
                joinPartType: joinPartType || (isJoinPart ? 'join' : 'info'),
                msgid: tags?.msgid || null,
                timestamp: new Date().toLocaleTimeString(), _ts: Date.now(),
            });
            if (target === this.currentChannel && !this.isScrolledUp) this.scrollToBottom();
        },

        scheduleBulkJoinTimeout() {
            clearTimeout(this._bulkJoinTimer);
            // Failed JOINs (ban, invite-only, ...) never confirm, don't wait forever.
            this._bulkJoinTimer = setTimeout(() => {
                if (this._bulkJoining > 0) {
                    this._bulkJoining = 0;
                    this.finishBulkJoin();
                }
            }, BULK_JOIN_TIMEOUT_MS);
        },

        finishBulkJoin() {
            clearTimeout(this._bulkJoinTimer);
            // A tapped push notification wins over the channel that was open last time
            if (!this.applyPendingPushTarget?.()) {
                const target = this._pendingActiveChannel;
                this._pendingActiveChannel = null;
                if (target && this.availableChannels.some(c => c.toLowerCase() === target)) {
                    this.switchChannel(target);
                }
            }
            // Something shared to the app while it was still connecting
            this.showPendingShare?.();
        },

        /**
         * Called when a CHATHISTORY batch for `target` is complete.
         */
        finishHistoryBatch(target) {
            const requestType   = this.historyRequestTypeByTarget[target] || 'latest';
            const chatWindow    = this.$refs.chatMessages || document.querySelector('.chat-messages');
            const prevHeight    = chatWindow?.scrollHeight || 0;
            const prevScrollTop = chatWindow?.scrollTop || 0;
            this.historyLoadingByTarget[target] = false;
            this.historyReceivedByTarget[target] = true;
            if (requestType === 'latest') this.completeHistoryRequest(target);

            const flushed = this.messageManager.flushBuffer(target);
            this.applyOrphanAnnotations(target, flushed);
            if (flushed.length === 0) {
                if (requestType === 'before') this.historyExhaustedByTarget[target] = true;
                return;
            }

            if (!this.isTargetVisible(target)) {
                this.recountUnread(target);
            } else if (this.unreadMarkerByChannel[target] == null) {
                this.placeUnreadMarker(target);
            }

            this.$nextTick(() => requestAnimationFrame(() => {
                if (target !== this.currentChannel) return;
                const activeChatWindow = this.$refs.chatMessages || document.querySelector('.chat-messages');
                if (!activeChatWindow) return;

                if (requestType === 'before') {
                    activeChatWindow.scrollTop = prevScrollTop + (activeChatWindow.scrollHeight - prevHeight);
                } else if (!this.isScrolledUp) {
                    this.scrollToUnreadOrBottom(target);
                }
            }));
        },

        handleChatMessage(msg, isNotice) {
            const batchId = msg.tags.batch;

            // Multiline batch member: collect the segment, display on BATCH end.
            const multilineBatch = batchId ? this.multilineBatchById[batchId] : null;
            if (multilineBatch) {
                multilineBatch.isNotice = isNotice;
                multilineBatch.segments.push({
                    text: msg.params[1] ?? '',
                    concat: Object.prototype.hasOwnProperty.call(msg.tags, 'draft/multiline-concat'),
                });
                return;
            }

            const sender = msg.nick;
            if (!sender) return;
            if (msg.fromServer && isNotice) return; // server notices

            const target       = msg.params[0] || '';
            const isHistorical = Boolean(batchId && this.activeBatches.has(batchId));
            let text           = msg.params[1] ?? '';

            if (!isHistorical) this.updateFriendPresence?.(sender, 'online');

            // CTCP
            if (text.startsWith('\u0001')) {
                text = text.replace(/^\u0001|\u0001$/g, '');
                const ctcpCommand = text.split(' ')[0].toUpperCase();
                const ctcpText    = text.slice(ctcpCommand.length).trim();
                const isLiveToMe  = sameNick(target, this.nickname) && !isHistorical && !sameNick(sender, this.nickname);
                // Replies to our own /ctcp requests (our replies to others come back as echo)
                if (isNotice) {
                    if (isLiveToMe && ctcpCommand !== 'ACTION') this.showCtcpReply?.(sender, ctcpCommand, ctcpText);
                    return;
                }
                if (ctcpCommand === 'PING') {
                    if (isLiveToMe) this.sendRaw(`NOTICE ${sender} :\u0001PING${ctcpText ? ` ${ctcpText.slice(0, 64)}` : ''}\u0001`);
                    return;
                }
                if (ctcpCommand === 'TIME') {
                    if (isLiveToMe) this.sendRaw(`NOTICE ${sender} :\u0001TIME ${new Date().toString()}\u0001`);
                    return;
                }
                if (ctcpCommand === 'AVATAR') {
                    // KVIrc: a bare request is answered with a URL, so no DCC is involved
                    if (!isNotice && text.toUpperCase() === 'AVATAR' && sameNick(target, this.nickname) && !isHistorical && this.ownAvatarUrl && this.hasFeature('profiles')) {
                        this.sendRaw(`NOTICE ${sender} :\u0001AVATAR ${this.ownAvatarUrl}\u0001`);
                    }
                    return;
                }
                if (ctcpCommand === 'VERSION') {
                    // Only answer bare VERSION requests addressed to us; swallow replies.
                    if (!isNotice && text.toUpperCase() === 'VERSION' && sameNick(target, this.nickname) && !isHistorical) {
                        this.sendRaw(`NOTICE ${sender} :\u0001VERSION ${this.ctcpVersionString}\u0001`);
                    }
                    return;
                }
                if (ctcpCommand !== 'ACTION') return;
            }

            if (this.ignoredUsers.some(ignored => sameNick(ignored, sender))) return;

            const isAction = text.startsWith('ACTION ');
            if (isAction) text = text.substring(7);

            const isToMe         = sameNick(target, this.nickname);
            const fromMe         = sameNick(sender, this.nickname);

            // Service replies (NickServ, ChanServ, ...) belong in the server window unless
            // a DM window with the service is open. Own commands to services were already
            // echoed there when they were sent.
            const serviceNick = isToMe && isServiceNick(sender) ? sender : (fromMe && isServiceNick(target) ? target : null);
            if (serviceNick && !this.hasOpenQuery(serviceNick)) {
                if (!isHistorical && !fromMe) {
                    this.addToServerWindow(isAction ? `${sender} ${text}` : text, { kind: 'notice', from: sender });
                }
                return;
            }

            const resolvedTarget = this.resolveTargetKey(isToMe ? sender : target);

            // echo-message: our own message coming back: the local copy gets its msgid
            if (fromMe && !isHistorical && this.consumeEcho(resolvedTarget, text, isAction, msg.tags)) return;

            // Clear typing indicator when a message arrives (IRCv3 spec)
            if (!isHistorical) {
                const timerKey = `${resolvedTarget}|${sender}`;
                clearTimeout(this._typingTimers.get(timerKey));
                this._typingTimers.delete(timerKey);
                this.activeUsers.setTyping(resolvedTarget, sender, false);
            }

            const dedupKey     = this.getMessageDedupKey(resolvedTarget, sender, text, isNotice, msg.tags);
            const seenMessages = this.ensureSeenMessageBucket(resolvedTarget);
            if (seenMessages.has(dedupKey)) return;
            seenMessages.add(dedupKey);
            if (isHistorical && seenMessages.has(`${resolvedTarget}|text|${sender}|${text}`)) return;

            const parsedTs = msg.tags.time ? Date.parse(msg.tags.time) : NaN;
            const ts       = Number.isFinite(parsedTs) ? parsedTs : Date.now();

            const messageObj = {
                user: sender, text, isAction, isNotice, isJoinPart: false,
                timestamp: legacyTimestamp(ts),
                _ts: ts,
                msgid: msg.tags.msgid || null,
                replyTo: msg.tags['+draft/reply'] || msg.tags['+reply'] || null,
                nickColor: this.getNickColor(sender),
                isHistorical,
            };

            if (isHistorical) {
                this.updateHistoryCursor(resolvedTarget, msg.tags);
                this.messageManager.bufferAdd(resolvedTarget, messageObj);
                return;
            }

            const stored    = this.messageManager.add(resolvedTarget, messageObj);
            this.applyOrphanAnnotations(resolvedTarget, [stored]);
            const visible   = this.isTargetVisible(resolvedTarget);
            const isMention = !fromMe && !isToMe && this.isHighlightedText(text);
            const notifyLevel = this.channelNotifyLevel(resolvedTarget);
            const muted = notifyLevel === 'mute';
            // "mentions": only mentions (and DMs) may raise popups or flash the taskbar
            const notifies = !muted && (notifyLevel === 'all' || isMention || isToMe);
            if (visible) this.scheduleReadMarker(resolvedTarget);

            if (isMention && !visible && !muted) {
                this.mentionsByChannel[resolvedTarget] = (this.mentionsByChannel[resolvedTarget] || 0) + 1;
                this.hasMentions = true;
                this.mentionCount++;
                this.notifyMention(sender, resolvedTarget, text);
            }

            if (!fromMe && notifies) {
                this.notifyHost('incoming-message', { sender, channel: resolvedTarget, text, isDm: isToMe, isMention });
            }

            if (resolvedTarget === this.currentChannel) {
                if (this.isScrolledUp) {
                    if (!fromMe) this.newWhileScrolledUp++;
                } else {
                    this.scrollToBottom();
                }
            }

            if (notifies && !document.hasFocus()) {
                this.notifyHost('unread-update', { hasUnread: true });
            }

            if (!fromMe && !visible && !muted) {
                // Current channel in a hidden tab: mark the first new message
                if (resolvedTarget === this.currentChannel && this.unreadMarkerByChannel[resolvedTarget] == null) {
                    this.unreadMarkerByChannel[resolvedTarget] = stored.id;
                }
                this.unreadMessages[resolvedTarget] = (this.unreadMessages[resolvedTarget] || 0) + 1;
            }

            if (isToMe && !fromMe) {
                this.scheduleChatStateSave?.();
            }
            this.emitUnreadState();
        },

        /**
         * Reassemble a completed draft/multiline batch into a single message.
         * Lines join with a linefeed unless the segment carried the
         * draft/multiline-concat tag, in which case it is appended directly.
         */
        assembleMultilineBatch(batchId) {
            const batch = this.multilineBatchById[batchId];
            if (!batch || batch.segments.length === 0) {
                return;
            }

            const fullText = batch.segments
                .map((segment, index) => (index === 0 || segment.concat ? '' : '\n') + segment.text)
                .join('');

            // A `batch` tag on the multiline batch points to a *parent* batch: keep it only
            // when it is an active chathistory batch, otherwise the live message would be
            // treated as history.
            const tags = { ...batch.tags };
            if (tags.batch && !this.activeBatches.has(tags.batch)) delete tags.batch;

            this.handleChatMessage({
                raw: '',
                tags,
                source: batch.source,
                nick: batch.sender,
                fromServer: false,
                command: batch.isNotice ? 'NOTICE' : 'PRIVMSG',
                params: [batch.target, fullText],
                hasTrailing: true,
            }, batch.isNotice);
        },
    };
}
