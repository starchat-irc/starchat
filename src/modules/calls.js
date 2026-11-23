/**
 * Calls module (feature "calls")
 * Voice calls between two friends from the DM window. Needs the voice and friends modules.
 *
 *  - The call is a LiveKit room of its own, joined through the voice module like a
 *    channel voice chat. Only one voice room at a time.
 *  - The network's API hands out the room token only to friends (POST chat/voice/call-token).
 *  - Ringing runs over IRC as TAGMSG with the client tag CALL_TAG:
 *      invite → ringing (it rings here) | unavailable (calls switched off or no voice here) | busy,
 *      then accept | decline,  cancel (caller gave up),  end (hung up).
 *    A client without call support ignores the invite: no "ringing" within
 *    CALL_ACK_TIMEOUT_MS tells the caller so, instead of ringing into the void.
 *    CALL_ID_TAG keeps two calls apart. Other sessions of the own account see the
 *    answer as echo and stop ringing.
 *  - App builds of the other side also ring through the network (POST chat/voice/call-ring,
 *    e.g. FCM); a tapped notification opens the chat with the target "call:<params>"
 *    (openCallFromPush).
 *  - In the background the chat shows a system notification and tells the host
 *    (notifyHost 'call-incoming'), so a desktop shell can flash its window.
 *  - Calls are private: no IRC metadata, nothing in the nick list.
 */
import { SCOPE } from '../ui/settings/registry.js';

export const CALL_TAG = '+getstarchat.net/call';
export const CALL_ID_TAG = '+getstarchat.net/call-id';
const CALL_ACTIONS = ['invite', 'ringing', 'unavailable', 'accept', 'decline', 'busy', 'cancel', 'end'];

/** How long the caller waits for "ringing" before assuming the other client cannot take calls. */
export const CALL_ACK_TIMEOUT_MS = 6000;

/** How long it rings before the caller gives up. */
export const CALL_RING_TIMEOUT_MS = 40000;
/** Ring sound interval while a call comes in. */
const RING_INTERVAL_MS = 2500;

const CALL_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;

function newCallId() {
    if (globalThis.crypto?.getRandomValues) {
        return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(16).slice(2, 18);
}

const lower = value => String(value || '').toLowerCase();

export function callsMixin() {
    return {
        /** Own call: { id, nick, account, direction: 'outgoing'|'incoming', state: 'ringing'|'active' } */
        voiceCall: null,
        /** Call coming in and not answered yet: { id, nick, account } */
        incomingCall: null,
        _callRingTimer: null,
        _callTimeout: null,
        _callAckTimeout: null,
        _callNotification: null,

        // Who can be called

        /** Friend list entry of a nick (case-insensitive), or null. */
        friendOfNick(nick) {
            const needle = lower(nick);
            return (needle && (this.friends || []).find(item => lower(item.user?.display) === needle)) || null;
        },

        /** Account of a friend by nick, or null for anyone who is no friend. */
        friendAccountOfNick(nick) {
            return this.friendOfNick(nick)?.user?.name || null;
        },

        isFriendAccount(account) {
            const needle = lower(account);
            return Boolean(needle) && (this.friends || []).some(item => lower(item.user?.name) === needle);
        },

        /** Calls need the feature, a usable voice chat, the friend list and the setting switched on. */
        callsAvailable() {
            return this.hasFeature('calls') && this.hasFeature('friends') && Boolean(this.voiceAvailable?.())
                && this.voiceSettings?.calls !== false;
        },

        canCallUser(nick = this.currentChannel) {
            return this.callsAvailable()
                && typeof nick === 'string'
                && nick !== '' && !nick.startsWith('#') && nick !== 'Server'
                && Boolean(this.friendAccountOfNick(nick))
                && Boolean(this.isFriendOnline?.(this.friendOfNick(nick).user.display))
                && !this.isIgnored?.(nick);
        },

        isInCallWith(nick) {
            return Boolean(this.voiceCall) && lower(this.voiceCall.nick) === lower(nick);
        },

        /** The call button waits while another voice room connects. */
        callButtonDisabled(nick) {
            return this.voice?.state === 'connecting' && !this.isInCallWith(nick);
        },

        // Signalling

        sendCallSignal(nick, action, id) {
            if (!nick || !this.canSendChat?.()) return false;
            this.sendRaw(`@${CALL_TAG}=${action};${CALL_ID_TAG}=${id} TAGMSG ${nick}`);
            return true;
        },

        /**
         * Rings (or stops ringing) the app builds of the other side through the network.
         * Resolves to the number of installs reached, 0 on any error.
         */
        async ringCallPush(call, action) {
            try {
                const response = await this.connection.api('chat/voice/call-ring', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ peer: call.account, call_id: call.id, nick: this.nickname, action }),
                });
                if (!response.ok) return 0;
                const data = await response.json().catch(() => ({}));
                return Number(data?.pushed) || 0;
            } catch {
                return 0;
            }
        },

        /** The caller gives up: IRC and, if an app was rung, the push notification too. */
        cancelOutgoingCall(call) {
            this.sendCallSignal(call.nick, 'cancel', call.id);
            if (call.pushed) this.ringCallPush(call, 'cancel');
        },

        /** TAGMSG with a call tag. Returns true when it was one (nothing else to do then). */
        handleCallTag(msg, fromMe) {
            const action = msg.tags?.[CALL_TAG];
            const id = msg.tags?.[CALL_ID_TAG];
            if (!action) return false;
            if (!CALL_ACTIONS.includes(action) || !CALL_ID_PATTERN.test(id || '') || !this.hasFeature('calls')) return true;

            if (fromMe) {
                // Another session of the own account answered: stop ringing here. Only accept and
                // decline count: "ringing" comes back as echo of our own answer (echo-message),
                // and every other session sends one too.
                if (this.incomingCall?.id === id && (action === 'accept' || action === 'decline')) this.stopIncomingCall();
                return true;
            }

            const nick = msg.nick;
            if (action === 'invite') this.receiveCallInvite(nick, id, msg.tags?.account || null);
            else if (action === 'cancel') this.callCancelled(nick, id);
            else if (this.voiceCall?.id === id) this.callAnswered(action);
            return true;
        },

        // Outgoing

        async startCall(nick = this.currentChannel) {
            if (!this.canCallUser(nick) || this.voiceCall) return false;
            const account = this.friendAccountOfNick(nick);
            if (this.isInVoice()) await this.leaveVoice();
            this.stopIncomingCall();

            const id = newCallId();
            this.voiceCall = { id, nick, account, direction: 'outgoing', state: 'ringing' };
            const joined = await this.joinCallRoom(this.voiceCall);
            if (!joined || this.voiceCall?.id !== id) return false;

            this.sendCallSignal(nick, 'invite', id);
            // The app of the other side may be in the background: ring it through the network.
            // Reaching an app counts as "it rings there", like a "ringing" answer over IRC.
            this.ringCallPush(this.voiceCall, 'invite').then(pushed => {
                if (!pushed || this.voiceCall?.id !== id) return;
                clearTimeout(this._callAckTimeout);
                this.voiceCall = { ...this.voiceCall, acknowledged: true, pushed: true };
            });
            clearTimeout(this._callAckTimeout);
            this._callAckTimeout = setTimeout(() => {
                if (this.voiceCall?.id !== id || this.voiceCall.acknowledged || this.voiceCall.state !== 'ringing') return;
                this.cancelOutgoingCall(this.voiceCall);
                this.finishCall('voice_call_unsupported');
            }, CALL_ACK_TIMEOUT_MS);
            clearTimeout(this._callTimeout);
            this._callTimeout = setTimeout(() => {
                if (this.voiceCall?.id !== id || this.voiceCall.state !== 'ringing') return;
                this.cancelOutgoingCall(this.voiceCall);
                this.finishCall('voice_call_no_answer');
            }, CALL_RING_TIMEOUT_MS);
            return true;
        },

        joinCallRoom(call) {
            return this.connectVoiceRoom({
                target: lower(call.nick),
                kind: 'call',
                tokenPath: 'chat/voice/call-token',
                tokenBody: { peer: call.account, nick: this.nickname },
            });
        },

        /** The other side answered our invite (or hung up). */
        callAnswered(action) {
            const call = this.voiceCall;
            if (!call) return;
            // Answered somewhere: the notification on the other apps of that person can go
            if (call.pushed && call.direction === 'outgoing' && action !== 'ringing') {
                this.ringCallPush(call, 'cancel');
                this.voiceCall = { ...call, pushed: false };
            }
            if (action === 'ringing' && call.direction === 'outgoing') {
                clearTimeout(this._callAckTimeout);
                this.voiceCall = { ...call, acknowledged: true };
            } else if (action === 'unavailable') {
                this.finishCall('voice_call_unavailable');
            } else if (action === 'accept' && call.direction === 'outgoing') {
                clearTimeout(this._callTimeout);
                this.voiceCall = { ...call, state: 'active' };
            } else if (action === 'decline') {
                this.finishCall('voice_call_declined');
            } else if (action === 'busy') {
                this.finishCall('voice_call_busy');
            } else if (action === 'end') {
                this.finishCall('voice_call_ended');
            }
        },

        // Incoming

        receiveCallInvite(nick, id, account) {
            // Friends only: the server's account tag when present, otherwise the friend list by nick
            const isFriend = account ? this.isFriendAccount(account) : Boolean(this.friendAccountOfNick(nick));
            if (!isFriend || this.isIgnored?.(nick)) return;
            // Calls switched off here (or no voice): say so, the caller would wait otherwise
            if (!this.callsAvailable()) {
                this.sendCallSignal(nick, 'unavailable', id);
                return;
            }

            if (this.voiceCall || (this.incomingCall && this.incomingCall.id !== id)) {
                this.sendCallSignal(nick, 'busy', id);
                return;
            }
            this.incomingCall = { id, nick, account: account || this.friendAccountOfNick(nick) };
            this.sendCallSignal(nick, 'ringing', id);
            this.ringIncomingCall();
            this.showCallNotification(this.incomingCall);
            clearTimeout(this._callTimeout);
            this._callTimeout = setTimeout(() => {
                if (this.incomingCall?.id === id) this.missedCall(nick);
            }, CALL_RING_TIMEOUT_MS + 5000);
        },

        ringIncomingCall() {
            clearInterval(this._callRingTimer);
            // The ring always sounds, even with the voice sounds switched off
            const ring = () => this._playVoiceSound?.('ring', { sinkId: this.voiceSettings?.outputDeviceId });
            ring();
            this._callRingTimer = setInterval(ring, RING_INTERVAL_MS);
        },

        /**
         * Chat in the background: a system notification, and the host learns about the
         * call (a desktop shell flashes its window). App builds ring natively instead.
         */
        showCallNotification(call) {
            const inBackground = globalThis.document?.hidden || globalThis.document?.hasFocus?.() === false;
            if (!call || !inBackground || this.shell === 'mobile') return;
            this.notifyHost('call-incoming', { nick: call.nick });
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
            try {
                const notification = new Notification(this.t('voice_call_incoming', { nick: call.nick }), {
                    body: this.t('voice_call_notification_body'),
                    tag: `starchat:call-${call.id}`,
                    requireInteraction: true,
                    // The chat rings itself
                    silent: true,
                });
                notification.onclick = () => {
                    globalThis.focus?.();
                    this.switchChannel?.(this.resolveTargetKey?.(call.nick) || call.nick);
                    notification.close();
                };
                this._callNotification = notification;
            } catch {
                // Some browsers only allow notifications from a service worker
            }
        },

        stopIncomingCall() {
            this._callNotification?.close?.();
            this._callNotification = null;
            clearInterval(this._callRingTimer);
            this._callRingTimer = null;
            if (this.incomingCall) clearTimeout(this._callTimeout);
            this.incomingCall = null;
        },

        callCancelled(nick, id) {
            if (this.incomingCall?.id === id) this.missedCall(nick);
            else if (this.voiceCall?.id === id) this.finishCall('voice_call_ended');
        },

        missedCall(nick) {
            this.stopIncomingCall();
            this.addSystemLine?.(this.resolveTargetKey?.(nick) || nick, this.t('voice_call_missed', { nick }));
        },

        async acceptCall() {
            const call = this.incomingCall;
            if (!call) return false;
            this.stopIncomingCall();
            if (this.isInVoice()) await this.leaveVoice();

            this.voiceCall = { id: call.id, nick: call.nick, account: call.account, direction: 'incoming', state: 'active' };
            const joined = await this.joinCallRoom(this.voiceCall);
            if (!joined) {
                this.sendCallSignal(call.nick, 'decline', call.id);
                this.voiceCall = null;
                return false;
            }
            // The caller waits in the room while it rings: an empty room means they gave up
            const callerThere = this.voice.participants.some(participant => lower(participant.identity) === lower(call.account));
            if (!callerThere) {
                await this.finishCall('voice_call_gone');
                return false;
            }
            this.sendCallSignal(call.nick, 'accept', call.id);
            this.switchChannel?.(this.resolveTargetKey?.(call.nick) || call.nick);
            return true;
        },

        declineCall() {
            const call = this.incomingCall;
            if (!call) return;
            this.stopIncomingCall();
            this.sendCallSignal(call.nick, 'decline', call.id);
        },

        // Ending

        /** Hang up: the own button, or leaving the voice room in any other way. */
        async hangUpCall() {
            const call = this.voiceCall;
            if (!call) return;
            if (call.state === 'ringing' && call.direction === 'outgoing') this.cancelOutgoingCall(call);
            else this.sendCallSignal(call.nick, 'end', call.id);
            await this.finishCall();
        },

        async finishCall(reasonKey = null) {
            const call = this.voiceCall;
            clearTimeout(this._callTimeout);
            clearTimeout(this._callAckTimeout);
            this.voiceCall = null;
            if (call && this.voice.kind === 'call') await this.leaveVoice();
            if (call && reasonKey) this.showVoiceNotice(this.t(reasonKey, { nick: call.nick }));
        },

        /** Voice module: the other side entered or left the LiveKit room. */
        voiceCallParticipantEvent(event, identity) {
            const call = this.voiceCall;
            if (!call || lower(identity) !== lower(call.account)) return;
            if (event === 'joined') {
                // Also covers a lost "accept": being in the room is the answer
                clearTimeout(this._callTimeout);
                clearTimeout(this._callAckTimeout);
                if (call.state === 'ringing') this.voiceCall = { ...call, state: 'active' };
            } else if (event === 'left') {
                this.finishCall('voice_call_ended');
            }
        },

        /** Voice module: a voice room was left (own button, error, connection lost). */
        voiceRoomLeft(kind) {
            if (kind !== 'call' || !this.voiceCall) return;
            const call = this.voiceCall;
            this.voiceCall = null;
            clearTimeout(this._callTimeout);
            clearTimeout(this._callAckTimeout);
            if (call.state === 'ringing' && call.direction === 'outgoing') this.cancelOutgoingCall(call);
            else this.sendCallSignal(call.nick, 'end', call.id);
        },

        // App notification tapped

        /**
         * Target "call:id=…&nick=…&account=…&answer=accept|decline" from the app shell.
         * Waits for the connection and the friend list (cold start), then answers or rings.
         */
        openCallFromPush(params, attempt = 0) {
            const query = new URLSearchParams(params);
            const call = { id: query.get('id') || '', nick: query.get('nick') || '', account: query.get('account') || '' };
            if (!CALL_ID_PATTERN.test(call.id) || !call.nick || !call.account) return;
            if (!this.isRegistered || !(this.friends || []).length) {
                // Cold start: try again for about 20 seconds
                if (attempt < 40) setTimeout(() => this.openCallFromPush(params, attempt + 1), 500);
                return;
            }
            if (!this.isFriendAccount(call.account)) return;
            this.switchChannel?.(this.resolveTargetKey?.(call.nick) || call.nick);

            const answer = query.get('answer');
            if (answer === 'decline') {
                this.sendCallSignal(call.nick, 'decline', call.id);
                return;
            }
            if (!this.callsAvailable()) {
                this.sendCallSignal(call.nick, 'unavailable', call.id);
                return;
            }
            if (this.voiceCall?.id === call.id) return;
            this.incomingCall = call;
            if (answer === 'accept') {
                this.acceptCall();
            } else {
                this.ringIncomingCall();
                clearTimeout(this._callTimeout);
                this._callTimeout = setTimeout(() => {
                    if (this.incomingCall?.id === call.id) this.missedCall(call.nick);
                }, CALL_RING_TIMEOUT_MS);
            }
        },

        /** Status line of the voice bar during a call. */
        voiceCallLabel() {
            const call = this.voiceCall;
            if (!call) return '';
            return call.state === 'ringing' ? this.t('voice_call_ringing', { nick: call.nick }) : this.t('voice_call_with', { nick: call.nick });
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export function registerCallsSettings(registry) {
    registry.registerSetting({
        id: 'voice.calls',
        section: 'voice',
        type: 'toggle',
        scope: SCOPE.Device,
        order: 15,
        label: 'settings_voice_calls',
        hint: 'settings_voice_calls_hint',
        keywords: ['anruf', 'anrufe', 'call', 'calls', 'privat', 'private', 'klingeln', 'ring'],
        when: env => env.hasFeature('calls') && env.hasFeature('friends'),
        get: chat => chat.voiceSettings?.calls !== false,
        set: (chat, value) => chat.setVoiceSetting('calls', Boolean(value)),
    });
}

/** @type {import('./index.js').ChatModule} */
export const callsModule = {
    name: 'calls',
    mixin: callsMixin,
    register: registerCallsSettings,
    hooks: {
        /** A ringing call ends with the account. */
        loggingOut() {
            if (this.incomingCall) this.declineCall();
            if (this.voiceCall) this.hangUpCall();
        },
    },
};
