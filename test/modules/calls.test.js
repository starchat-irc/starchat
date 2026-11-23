/**
 * Calls module: ringing over TAGMSG, the call token, timeouts and app notifications.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { CALL_ACK_TIMEOUT_MS, CALL_ID_TAG, CALL_TAG, callsModule, registerCallsSettings } from '../../src/modules/calls.js';
import { friendsModule } from '../../src/modules/friends.js';
import { registerVoiceSettings, voiceModule } from '../../src/modules/voice.js';
import { createSettingsRegistry } from '../../src/ui/settings/registry.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { json, loggedInChat } from './module-harness.js';

const FRIENDS = { friends: [{ friendship_id: 1, status: 'accepted', user: { display: 'Bob', name: 'bob' } }] };

function installMediaStubs() {
    globalThis.RTCPeerConnection = function RTCPeerConnection() {};
    globalThis.AudioWorkletNode = function AudioWorkletNode() {};
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
}

beforeEach(() => {
    installBrowserStubs();
    installMediaStubs();
});

afterEach(() => {
    delete globalThis.RTCPeerConnection;
    delete globalThis.AudioWorkletNode;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/** Logged in as alice, Bob is an online friend, voice switched on, LiveKit faked. */
async function callChat(routes = {}, { participants = [] } = {}) {
    const result = await loggedInChat(
        {
            'GET friends': json(FRIENDS),
            'POST chat/voice/call-token': json({ url: 'wss://voice.example.org', token: 'call-token' }),
            'POST chat/voice/call-ring': json({ pushed: 0 }),
            'GET chat/voice/filters': json({ filters: [] }),
            ...routes,
        },
        { modules: [friendsModule, voiceModule, callsModule], features: ['friends', 'voice', 'calls'] },
    );
    const { chat } = result;
    await chat.fetchFriends();
    chat.updateFriendPresence('Bob', 'online');
    chat._playVoiceSound = () => {};
    chat._voiceModule = async () => ({
        async createVoiceSession(options) {
            return {
                async connect() { options.onParticipants(participants); },
                async disconnect() {},
            };
        },
        async listAudioDevices() { return { inputs: [], outputs: [], canSelectOutput: false }; },
        usableVoiceFilters: () => [],
    });
    return result;
}

const tagmsg = (from, action, id, account = from.toLowerCase()) =>
    `@${CALL_TAG}=${action};${CALL_ID_TAG}=${id};account=${account} :${from}!u@h TAGMSG alice`;

test('only online friends can be called, and only where voice works', async () => {
    const { chat } = await callChat();
    assert.equal(chat.canCallUser('Bob'), true);
    assert.equal(chat.canCallUser('bob'), true);
    assert.equal(chat.canCallUser('Mallory'), false);
    assert.equal(chat.canCallUser('#bridge'), false);

    chat.updateFriendPresence('Bob', 'offline');
    assert.equal(chat.canCallUser('Bob'), false);

    chat.updateFriendPresence('Bob', 'online');
    delete globalThis.RTCPeerConnection;
    assert.equal(chat.canCallUser('Bob'), false, 'browser without WebRTC');
});

test('a call asks for the call token with the friend account and rings over IRC', async () => {
    const { chat, fetch, sent } = await callChat();

    assert.equal(await chat.startCall('Bob'), true);

    const tokenCall = fetch.calls.find(entry => entry.path === 'chat/voice/call-token');
    assert.deepEqual(JSON.parse(tokenCall.init.body), { peer: 'bob', nick: 'alice' });
    const invite = sent.find(line => line.includes('TAGMSG Bob'));
    assert.match(invite, new RegExp(`^@\\${CALL_TAG}=invite;\\${CALL_ID_TAG}=[0-9a-f]{16} TAGMSG Bob$`));
    assert.equal(chat.voice.kind, 'call');
    assert.ok(!sent.some(line => line.startsWith('METADATA * SET voice :')), 'calls are not announced');
    assert.equal(chat.voiceCall.state, 'ringing');

    const ring = fetch.calls.find(entry => entry.path === 'chat/voice/call-ring');
    assert.equal(JSON.parse(ring.init.body).action, 'invite');
    await chat.hangUpCall();
});

test('without a "ringing" answer the caller learns that the other client cannot take calls', async () => {
    const { chat, sent } = await callChat();
    vi.useFakeTimers();
    await chat.startCall('Bob');
    const id = chat.voiceCall.id;

    await vi.advanceTimersByTimeAsync(CALL_ACK_TIMEOUT_MS + 10);

    assert.equal(chat.voiceCall, null);
    assert.ok(sent.includes(`@${CALL_TAG}=cancel;${CALL_ID_TAG}=${id} TAGMSG Bob`));
    assert.equal(chat.voiceError, chat.t('voice_call_unsupported', { nick: 'Bob' }));
});

test('"ringing" and "accept" from the friend make the call active', async () => {
    const { chat } = await callChat();
    await chat.startCall('Bob');
    const id = chat.voiceCall.id;

    chat.handleMessage({ data: tagmsg('Bob', 'ringing', id) });
    assert.equal(chat.voiceCall.acknowledged, true);
    chat.handleMessage({ data: tagmsg('Bob', 'accept', id) });
    assert.equal(chat.voiceCall.state, 'active');

    chat.handleMessage({ data: tagmsg('Bob', 'end', id) });
    await vi.waitFor(() => assert.equal(chat.voiceCall, null));
    assert.equal(chat.voice.state, 'idle');
});

test('an invite from a friend rings, others are ignored', async () => {
    const { chat, sent } = await callChat();

    chat.handleMessage({ data: tagmsg('Mallory', 'invite', 'abc123') });
    assert.equal(chat.incomingCall, null);
    assert.ok(!sent.some(line => line.includes('TAGMSG Mallory')));

    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });
    assert.deepEqual(chat.incomingCall, { id: 'abc123', nick: 'Bob', account: 'bob' });
    assert.ok(sent.includes(`@${CALL_TAG}=ringing;${CALL_ID_TAG}=abc123 TAGMSG Bob`));

    chat.declineCall();
    assert.equal(chat.incomingCall, null);
    assert.ok(sent.includes(`@${CALL_TAG}=decline;${CALL_ID_TAG}=abc123 TAGMSG Bob`));
});

test('without WebRTC an invite is answered with "unavailable"', async () => {
    const { chat, sent } = await callChat();
    delete globalThis.RTCPeerConnection;

    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });

    assert.equal(chat.incomingCall, null);
    assert.ok(sent.includes(`@${CALL_TAG}=unavailable;${CALL_ID_TAG}=abc123 TAGMSG Bob`));
});

test('with private calls switched off nothing rings and nobody can be called', async () => {
    const { chat, sent } = await callChat();
    chat.setVoiceSetting('calls', false);

    assert.equal(chat.canCallUser('Bob'), false);
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });
    assert.equal(chat.incomingCall, null);
    assert.ok(sent.includes(`@${CALL_TAG}=unavailable;${CALL_ID_TAG}=abc123 TAGMSG Bob`));

    chat.openCallFromPush('id=def456&nick=Bob&account=bob');
    assert.equal(chat.incomingCall, null, 'a late app notification does not ring either');
    assert.ok(sent.includes(`@${CALL_TAG}=unavailable;${CALL_ID_TAG}=def456 TAGMSG Bob`));

    chat.setVoiceSetting('calls', true);
    assert.equal(chat.canCallUser('Bob'), true);
});

test('switching private calls off declines a ringing call', async () => {
    const { chat, sent } = await callChat();
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });
    assert.ok(chat.incomingCall);

    chat.setVoiceSetting('calls', false);

    assert.equal(chat.incomingCall, null);
    assert.ok(sent.includes(`@${CALL_TAG}=decline;${CALL_ID_TAG}=abc123 TAGMSG Bob`));
});

test('the call switch shows in the voice settings only with calls and friends', () => {
    const registry = createSettingsRegistry();
    registerVoiceSettings(registry);
    registerCallsSettings(registry);
    const env = features => ({ shell: null, hasFeature: name => features.includes(name), hasAccount: true, hasToken: true });
    const ids = features => registry.settingsFor('voice', env(features)).map(setting => setting.id);

    assert.ok(ids(['voice', 'calls', 'friends']).includes('voice.calls'));
    assert.ok(!ids(['voice', 'calls']).includes('voice.calls'));
    assert.ok(!ids(['voice']).includes('voice.calls'));
});

test('a second call while one rings gets "busy"', async () => {
    const { chat, sent } = await callChat();
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'first1') });
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'second2') });

    assert.equal(chat.incomingCall.id, 'first1');
    assert.ok(sent.includes(`@${CALL_TAG}=busy;${CALL_ID_TAG}=second2 TAGMSG Bob`));
    chat.stopIncomingCall();
});

test('accepting joins the room and answers when the caller is still there', async () => {
    const { chat, sent } = await callChat({}, { participants: [{ identity: 'Bob' }, { identity: 'alice', isLocal: true }] });
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });

    assert.equal(await chat.acceptCall(), true);

    assert.ok(sent.includes(`@${CALL_TAG}=accept;${CALL_ID_TAG}=abc123 TAGMSG Bob`));
    assert.equal(chat.voiceCall.state, 'active');
    assert.equal(chat.incomingCall, null);
    await chat.hangUpCall();
    assert.ok(sent.includes(`@${CALL_TAG}=end;${CALL_ID_TAG}=abc123 TAGMSG Bob`));
});

test('accepting a call whose caller already left ends it', async () => {
    const { chat } = await callChat({}, { participants: [{ identity: 'alice', isLocal: true }] });
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });

    assert.equal(await chat.acceptCall(), false);
    assert.equal(chat.voiceCall, null);
    assert.equal(chat.voiceError, chat.t('voice_call_gone', { nick: 'Bob' }));
});

test('the answer of another own session stops the ringing here', async () => {
    const { chat } = await callChat();
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });

    chat.handleMessage({ data: `@${CALL_TAG}=ringing;${CALL_ID_TAG}=abc123 :alice!u@h TAGMSG Bob` });
    assert.ok(chat.incomingCall, 'own "ringing" echo changes nothing');
    chat.handleMessage({ data: `@${CALL_TAG}=accept;${CALL_ID_TAG}=abc123 :alice!u@h TAGMSG Bob` });
    assert.equal(chat.incomingCall, null);
});

test('call tags with unknown actions or bad ids are swallowed', async () => {
    const { chat, sent } = await callChat();
    const before = sent.length;

    chat.handleMessage({ data: tagmsg('Bob', 'explode', 'abc123') });
    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'bad id!') });

    assert.equal(chat.incomingCall, null);
    assert.equal(sent.length, before);
});

test('a tapped app notification with answer=decline declines over IRC', async () => {
    const { chat, sent } = await callChat();
    chat.openCallFromPush('id=abc123&nick=Bob&account=bob&answer=decline');
    assert.ok(sent.includes(`@${CALL_TAG}=decline;${CALL_ID_TAG}=abc123 TAGMSG Bob`));

    chat.openCallFromPush('id=abc123&nick=Mallory&account=mallory');
    assert.equal(chat.incomingCall, null, 'no friend');
});

test('in the background the host learns about an incoming call', async () => {
    const { chat } = await callChat();
    const messages = [];
    chat.notifyHost = (type, data) => messages.push({ type, data });
    globalThis.document.hidden = true;

    chat.handleMessage({ data: tagmsg('Bob', 'invite', 'abc123') });

    assert.deepEqual(messages, [{ type: 'call-incoming', data: { nick: 'Bob' } }]);
    chat.stopIncomingCall();
});
