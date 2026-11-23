/**
 * Voice module: availability, token request, metadata marker, errors and settings.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { describeVoiceError, readVoiceSettings, registerVoiceSettings, VoiceTokenError, voiceModule } from '../../src/modules/voice.js';
import { createSettingsRegistry } from '../../src/ui/settings/registry.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json, loggedInChat as baseLoggedInChat } from './module-harness.js';

const TOKEN = { url: 'wss://voice.example.org', token: 'room-token', is_moderator: true };

/** A voice session without LiveKit: records what the module asks of it. */
function fakeVoiceModule() {
    const sessions = [];
    return {
        sessions,
        load: async () => ({
            async createVoiceSession(options) {
                const session = {
                    options,
                    connected: false,
                    disconnected: false,
                    muted: null,
                    async connect() { this.connected = true; },
                    async disconnect() { this.disconnected = true; },
                    async setMicMuted(value) { this.muted = value; },
                    setGate() {},
                };
                sessions.push(session);
                return session;
            },
            async listAudioDevices() {
                return { inputs: [{ id: 'mic', label: 'Mic' }], outputs: [], canSelectOutput: false };
            },
            usableVoiceFilters: list => (Array.isArray(list) ? list.filter(entry => entry.id === 'rnnoise-v1') : []),
        }),
    };
}

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

async function voiceChat(routes = {}, options = {}) {
    const result = await baseLoggedInChat(
        { 'POST chat/voice/token': json(TOKEN), 'GET chat/voice/filters': json({ filters: [] }), ...routes },
        { modules: [voiceModule], features: ['voice'], ...options },
    );
    const fake = fakeVoiceModule();
    result.chat._voiceModule = fake.load;
    result.chat._playVoiceSound = () => {};
    result.chat._joinedChannels.add('#bridge');
    result.chat.currentChannel = '#bridge';
    result.fake = fake;
    return result;
}

test('voice needs the feature, a token and WebRTC, no opt-in', async () => {
    const { chat } = await voiceChat();
    assert.equal(chat.voiceAvailable(), true);
    assert.equal(chat.canJoinVoice('#bridge'), true);
    assert.equal(chat.canJoinVoice('#elsewhere'), false, 'not joined on IRC');

    delete globalThis.RTCPeerConnection;
    assert.equal(chat.voiceAvailable(), false, 'browser without WebRTC');
    globalThis.RTCPeerConnection = function RTCPeerConnection() {};

    const guest = chatWith(connectionWith(apiStub({}), { features: ['voice'] }), { modules: [voiceModule] }).chat;
    assert.equal(guest.voiceAvailable(), false, 'guests have no token');

    const plain = await voiceChat({}, { features: [] });
    assert.equal(plain.chat.voiceAvailable(), false, 'network without voice');
});

test('joining asks the API for a room token and announces the channel', async () => {
    const { chat, fetch, fake, sent } = await voiceChat();

    assert.equal(await chat.joinVoice('#Bridge'), true);

    const call = fetch.calls.find(entry => entry.path === 'chat/voice/token');
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.init.body), { channel: '#Bridge', nick: 'alice' });
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer jwt-1');
    assert.equal(fake.sessions[0].options.url, TOKEN.url);
    assert.equal(fake.sessions[0].options.token, TOKEN.token);
    assert.equal(fake.sessions[0].connected, true);
    assert.equal(chat.voice.state, 'connected');
    assert.equal(chat.voice.isModerator, true);
    assert.ok(chat.isInVoice('#bridge'));
    assert.ok(sent.includes('METADATA * SET voice :#bridge'));

    await chat.leaveVoice();
    assert.equal(fake.sessions[0].disconnected, true);
    assert.equal(chat.voice.state, 'idle');
    assert.equal(sent.at(-1), 'METADATA * SET voice');
});

test('a refused token shows the reason in own words', async () => {
    const { chat, fake } = await voiceChat({
        'POST chat/voice/token': json({ message: 'Du bist nicht im Channel.', reason: 'not_in_channel' }, 403),
    });

    assert.equal(await chat.joinVoice('#bridge'), false);
    assert.equal(fake.sessions.length, 0);
    assert.equal(chat.voice.state, 'idle');
    assert.equal(chat.voiceError, chat.t('voice_not_in_channel'));
});

test('describeVoiceError maps refusals and browser errors', () => {
    const t = key => key;
    assert.equal(describeVoiceError(new VoiceTokenError(404), t), 'voice_server_disabled');
    assert.equal(describeVoiceError(new VoiceTokenError(403, 'not_allowed'), t), 'voice_not_allowed');
    assert.match(describeVoiceError(new VoiceTokenError(500), t), /^voice_failed \(VoiceTokenError: HTTP 500\)$/);
    assert.match(describeVoiceError({ name: 'NotAllowedError', message: 'Permission denied by system' }, t), /^voice_mic_denied_system/);
    assert.match(describeVoiceError({ name: 'NotFoundError' }, t), /^voice_mic_missing/);
    assert.match(describeVoiceError({ name: 'Error', voicePhase: 'connect' }, t), /^voice_unreachable/);
});

test('leaving the IRC channel leaves its voice chat', async () => {
    const { chat } = await voiceChat();
    await chat.joinVoice('#bridge');

    chat.handleMessage({ data: ':alice!u@h PART #bridge' });
    assert.equal(chat.voice.state, 'idle');
    await vi.waitFor(() => assert.equal(chat.voiceError, chat.t('voice_left_channel')));
});

test('logging out leaves the voice chat while the socket is still open', async () => {
    const { chat, sent, fake } = await voiceChat();
    await chat.joinVoice('#bridge');

    chat.callModuleHook('loggingOut');
    assert.equal(sent.at(-1), 'METADATA * SET voice');
    await vi.waitFor(() => assert.equal(fake.sessions[0].disconnected, true));
});

test('closing the page clears the marker before the QUIT', async () => {
    const { chat, sent } = await voiceChat();
    await chat.joinVoice('#bridge');
    sent.length = 0;

    chat.callModuleHook('pageHide');
    assert.deepEqual(sent, ['METADATA * SET voice']);
});

test('the own marker is set again when another session cleared it, at most three times a minute', async () => {
    const { chat, sent } = await voiceChat();
    await chat.joinVoice('#bridge');
    sent.length = 0;

    for (let i = 0; i < 5; i++) chat.ownVoiceMarkerChanged('');
    assert.equal(sent.filter(line => line === 'METADATA * SET voice :#bridge').length, 3);

    sent.length = 0;
    chat.ownVoiceMarkerChanged('#bridge');
    assert.deepEqual(sent, []);
});

test('the filter list comes from the API once and keeps only known filters', async () => {
    const filters = [{ id: 'rnnoise-v1', wasm: 'https://home.example.org/x.wasm' }, { id: 'other', wasm: 'y' }];
    const { chat, fetch } = await voiceChat({ 'GET chat/voice/filters': json({ filters }) });

    await chat.loadVoiceFilters();
    await chat.loadVoiceFilters();

    assert.deepEqual(chat.voiceFilters.map(filter => filter.id), ['rnnoise-v1']);
    assert.equal(fetch.calls.filter(entry => entry.path === 'chat/voice/filters').length, 1);
});

test('settings are stored per device and sanitised on read', () => {
    localStorage.setItem('starchat.voice', JSON.stringify({ enabled: false, mode: 'shout', pttKey: 'KeyA', thresholdDb: 20 }));
    const settings = readVoiceSettings();
    assert.equal('enabled' in settings, false, 'the old opt-in switch is gone');
    assert.equal(settings.calls, true, 'private calls are on by default');
    assert.equal(settings.mode, 'vad');
    assert.equal(settings.pttKey, 'F8');
    assert.equal(settings.thresholdDb, 0);
});

test('the settings section only shows with the feature and a token', () => {
    const registry = createSettingsRegistry();
    registerVoiceSettings(registry);
    const env = (features, hasToken) => ({ shell: null, hasFeature: name => features.includes(name), hasAccount: hasToken, hasToken });

    assert.deepEqual(registry.sectionsFor(env(['voice'], true)).map(section => section.id), ['voice']);
    assert.deepEqual(registry.sectionsFor(env(['voice'], false)), []);
    assert.deepEqual(registry.sectionsFor(env([], true)), []);
});

test('push-to-talk opens the gate only while the key is held', async () => {
    const { chat, fake } = await voiceChat();
    chat.setVoiceSetting('mode', 'ptt');
    await chat.joinVoice('#bridge');
    const gates = [];
    fake.sessions[0].setGate = params => gates.push(params);
    const key = (code, extra = {}) => ({ code, repeat: false, preventDefault() {}, ...extra });

    chat.handleVoiceKey(key('F8'), true);
    chat.handleVoiceKey(key('F8', { repeat: true }), true);
    chat.handleVoiceKey(key('KeyA'), true);
    chat.handleVoiceKey(key('F8'), false);

    assert.deepEqual(gates, [{ pttActive: true }, { pttActive: false }]);
});
