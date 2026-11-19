/**
 * Voice module (feature "voice", experimental)
 * Voice chat per IRC channel through a LiveKit server of the network.
 *
 *  - Only offered when switched on under Settings → Voice chat, with a token of this
 *    connection (guests have none).
 *  - The network's API hands out the room token after checking that the own nick is in
 *    the channel (POST chat/voice/token, see docs/discovery.md).
 *  - Others see who is in a voice chat through the IRC metadata key "voice"
 *    (value = channel), shown as a speaker in the user list.
 *  - Leaving the IRC channel (PART, KICK) also leaves its voice chat.
 *  - Calls between friends (calls module) use the same session, see connectVoiceRoom().
 */
import { SCOPE } from '../ui/settings/registry.js';
import { VOICE_MODES, VOICE_PTT_KEYS, levelToPercent, percentToLevel } from '../voice/levels.js';
import { playVoiceSound } from '../voice/sounds.js';

const VOICE_SETTINGS_KEY = 'starchat.voice';
export const VOICE_METADATA_KEY = 'voice';

const DEFAULT_VOICE_SETTINGS = Object.freeze({
    enabled: false,
    mode: 'vad',
    pttKey: 'F8',
    thresholdDb: -50,
    noiseSuppression: true,
    /** Id of a filter offered by the server (voice/filters.js), '' for none. */
    noiseFilter: '',
    /** Sounds for join/leave and the own mute. */
    sounds: true,
    inputDeviceId: '',
    outputDeviceId: '',
    volumes: {},
});

/** How often per minute the own marker is set again, so two sessions in voice cannot fight forever. */
const VOICE_REASSERT_LIMIT = 3;

/** How long a voice error stays visible below the header. */
const VOICE_NOTICE_MS = 12000;

/** Refusals of the token request, by `reason` of the answer. */
const REASON_KEYS = {
    not_allowed: 'voice_not_allowed',
    whois_failed: 'voice_check_failed',
    wrong_account: 'voice_wrong_account',
    not_in_channel: 'voice_not_in_channel',
    not_friends: 'voice_call_not_friends',
};

export function readVoiceSettings() {
    try {
        const stored = JSON.parse(globalThis.localStorage?.getItem(VOICE_SETTINGS_KEY) || '{}');
        const settings = { ...DEFAULT_VOICE_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
        if (!VOICE_MODES.includes(settings.mode)) settings.mode = DEFAULT_VOICE_SETTINGS.mode;
        if (!VOICE_PTT_KEYS.includes(settings.pttKey)) settings.pttKey = DEFAULT_VOICE_SETTINGS.pttKey;
        settings.thresholdDb = Math.min(0, Math.max(-80, Number(settings.thresholdDb) || DEFAULT_VOICE_SETTINGS.thresholdDb));
        settings.sounds = settings.sounds !== false;
        settings.noiseFilter = typeof settings.noiseFilter === 'string' ? settings.noiseFilter : '';
        settings.volumes = settings.volumes && typeof settings.volumes === 'object' ? settings.volumes : {};
        return settings;
    } catch {
        return { ...DEFAULT_VOICE_SETTINGS, volumes: {} };
    }
}

function writeVoiceSettings(settings) {
    try {
        globalThis.localStorage?.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Private mode or blocked storage: the settings only last for this session
    }
}

/** A refused token request: HTTP status and the `reason` of the answer. */
export class VoiceTokenError extends Error {
    constructor(status, reason = '') {
        super(reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`);
        this.name = 'VoiceTokenError';
        this.status = status;
        this.reason = reason;
    }
}

/**
 * A readable explanation for a failed join or mic test, with the technical reason
 * in brackets so testers can report it.
 *
 * @param {(key: string) => string} t
 */
export function describeVoiceError(error, t) {
    const name = error?.name || '';
    const detail = [name, error?.message].filter(Boolean).join(': ');
    const withDetail = text => (detail ? `${text} (${detail})` : text);

    if (name === 'VoiceTokenError') {
        if (error.status === 404) return t('voice_server_disabled');
        if (REASON_KEYS[error.reason]) return t(REASON_KEYS[error.reason]);
        return withDetail(t('voice_failed'));
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        // Chromium names an OS-level block (Windows privacy settings) "by system"
        return withDetail(/system/i.test(error?.message || '') ? t('voice_mic_denied_system') : t('voice_mic_denied'));
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return withDetail(t('voice_mic_missing'));
    if (name === 'NotReadableError' || name === 'AbortError') return withDetail(t('voice_mic_busy'));
    if (error?.voicePhase === 'connect') return withDetail(t('voice_unreachable'));
    if (name === 'TypeError') return withDetail(t('voice_unreachable'));
    return withDetail(t('voice_failed'));
}

function sameChannel(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function emptyVoiceState() {
    return {
        /** Channel, or the DM key (nick) of a call. */
        channel: null,
        /** 'channel' or 'call' (calls module). */
        kind: 'channel',
        state: 'idle', // 'idle' | 'connecting' | 'connected' | 'reconnecting'
        participants: [],
        micMuted: false,
        deafened: false,
        level: -100,
        open: false,
        audioBlocked: false,
        isModerator: false,
        volumeFor: null,
    };
}

function loadVoiceSessionModule() {
    return import('../voice/session.js');
}

export function voiceMixin() {
    /**
     * Live LiveKit session and mic test of this component, deliberately outside the
     * Alpine state: reactive proxies break the private fields of the LiveKit classes.
     */
    let voiceSession = null;
    let voiceTestPipeline = null;
    let noticeTimer = null;
    /** Filter list of the server, loaded once per connection. */
    let filtersRequest = null;
    let reassertTimes = [];

    return {
        voiceSettings: readVoiceSettings(),
        voice: emptyVoiceState(),
        voiceError: '',
        voiceDevices: { inputs: [], outputs: [], canSelectOutput: false },
        voiceTest: { running: false, level: -100, open: false },
        /** Filters the server offers and this chat can run, see voice/filters.js. */
        voiceFilters: [],
        _voicePttDown: false,
        _voiceJoinAttempt: 0,
        /** Replaceable in tests. */
        _voiceModule: loadVoiceSessionModule,
        _playVoiceSound: playVoiceSound,

        // Availability

        voiceSupported() {
            return typeof globalThis.RTCPeerConnection === 'function'
                && Boolean(globalThis.navigator?.mediaDevices?.getUserMedia)
                && typeof globalThis.AudioWorkletNode === 'function';
        },

        voiceAvailable() {
            return Boolean(this.voiceSettings.enabled)
                && this.hasFeature('voice')
                && Boolean(this.hasApiToken)
                && this.voiceSupported();
        },

        canJoinVoice(channel = this.currentChannel) {
            return this.voiceAvailable()
                && typeof channel === 'string'
                && channel.startsWith('#')
                && Boolean(this._joinedChannels?.has(channel.toLowerCase()));
        },

        isInVoice(channel = null) {
            if (this.voice.state === 'idle') return false;
            return channel === null || sameChannel(this.voice.channel, channel);
        },

        // Join and leave

        async toggleVoice(channel = this.currentChannel) {
            if (this.isInVoice(channel)) return this.leaveVoice();
            return this.joinVoice(channel);
        },

        async joinVoice(channel = this.currentChannel) {
            if (!this.canJoinVoice(channel)) return false;
            return this.connectVoiceRoom({
                target: channel.toLowerCase(),
                kind: 'channel',
                tokenPath: 'chat/voice/token',
                tokenBody: { channel, nick: this.nickname },
            });
        },

        /**
         * Joins a LiveKit room: the voice chat of a channel or a call (calls module). Only
         * one at a time, a running one is left first. Resolves to true once connected.
         *
         * @param {{ target: string, kind: 'channel'|'call', tokenPath: string, tokenBody: object }} room
         */
        async connectVoiceRoom({ target, kind, tokenPath, tokenBody }) {
            if (this.isInVoice()) await this.leaveVoice();
            this.stopVoiceTest();

            const attempt = ++this._voiceJoinAttempt;
            this.dismissVoiceError();
            this.voice = { ...emptyVoiceState(), channel: target, kind, state: 'connecting' };

            try {
                const response = await this.connection.api(tokenPath, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tokenBody),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new VoiceTokenError(response.status, typeof data?.reason === 'string' ? data.reason : '');
                if (typeof data?.url !== 'string' || typeof data?.token !== 'string') throw new VoiceTokenError(response.status, 'invalid_answer');
                if (attempt !== this._voiceJoinAttempt) return false;

                this.voice.isModerator = Boolean(data.is_moderator);
                const { createVoiceSession } = await this._voiceModule();
                await this.loadVoiceFilters();
                if (attempt !== this._voiceJoinAttempt) return false;
                const session = await createVoiceSession({
                    url: data.url,
                    token: data.token,
                    settings: { ...this.voiceSettings },
                    volumes: { ...this.voiceSettings.volumes },
                    filter: this.selectedVoiceFilter(),
                    onFilterFailed: error => this.voiceFilterFailed(error),
                    onParticipantEvent: (event, identity) => {
                        if (voiceSession !== session) return;
                        this.playVoiceSoundFor(event === 'joined' ? 'join' : 'leave', { others: true });
                        this.voiceCallParticipantEvent?.(event, identity);
                    },
                    onState: state => this.onVoiceState(session, state),
                    onParticipants: participants => { if (voiceSession === session) this.voice.participants = participants; },
                    onLevel: (level, open) => { this.voice.level = level; this.voice.open = open; },
                    onAudioBlocked: blocked => { this.voice.audioBlocked = blocked; },
                });
                voiceSession = session;
                await session.connect();
                if (attempt !== this._voiceJoinAttempt || voiceSession !== session) {
                    await session.disconnect().catch(() => {});
                    return false;
                }
                this.voice.state = 'connected';
                this.playVoiceSoundFor('join');
                this.syncOwnVoice();
                this.refreshVoiceDevices();
                return true;
            } catch (error) {
                if (attempt !== this._voiceJoinAttempt) return false;
                await voiceSession?.disconnect().catch(() => {});
                voiceSession = null;
                this.voice = emptyVoiceState();
                this.showVoiceError(error);
                return false;
            }
        },

        /** Shows the error below the header (and in the voice settings) for a while. */
        showVoiceError(error) {
            console.warn('[voice]', error);
            this.showVoiceNotice(describeVoiceError(error, key => this.t(key)));
        },

        showVoiceNotice(text) {
            this.voiceError = text;
            clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => this.dismissVoiceError(), VOICE_NOTICE_MS);
        },

        dismissVoiceError() {
            clearTimeout(noticeTimer);
            noticeTimer = null;
            this.voiceError = '';
        },

        onVoiceState(session, state) {
            if (voiceSession !== session) return;
            if (state === 'disconnected') {
                const wasActive = this.voice.state !== 'idle';
                const kind = this.voice.kind;
                voiceSession = null;
                this.voice = emptyVoiceState();
                this.syncOwnVoice();
                if (wasActive) {
                    this.playVoiceSoundFor('leave');
                    this.showVoiceNotice(this.t('voice_disconnected'));
                }
                this.voiceRoomLeft?.(kind);
                return;
            }
            if (state === 'connected' || state === 'reconnecting') this.voice.state = state;
        },

        async leaveVoice(reasonKey = null) {
            this._voiceJoinAttempt++;
            const session = voiceSession;
            const wasActive = this.voice.state !== 'idle';
            const kind = this.voice.kind;
            voiceSession = null;
            this.voice = emptyVoiceState();
            this._voicePttDown = false;
            if (wasActive) {
                this.playVoiceSoundFor('leave');
                this.syncOwnVoice();
            }
            await session?.disconnect().catch(() => {});
            if (wasActive && reasonKey) this.showVoiceNotice(this.t(reasonKey));
            if (wasActive) this.voiceRoomLeft?.(kind);
        },

        /** Own PART or KICK: the voice chat belongs to the channel. */
        voiceChannelLeft(channel) {
            if (this.isInVoice(channel)) this.leaveVoice('voice_left_channel');
        },

        // IRC metadata

        /** Publishes (or clears) the own voice channel; re-asserted on every connect. */
        syncOwnVoice() {
            if (!this.supportsMetadata || !this.hasFeature('voice') || !this.canSendChat?.()) return;
            // Calls are private: only channel voice chats are announced
            const channel = this.voice.state !== 'idle' && this.voice.kind === 'channel' ? this.voice.channel : '';
            this.sendRaw(channel ? `METADATA * SET ${VOICE_METADATA_KEY} :${channel}` : `METADATA * SET ${VOICE_METADATA_KEY}`);
            if (this.nickname) this.activeUsers?.setVoice?.(this.nickname, channel);
        },

        /**
         * The server sent the own marker. It belongs to the nick, so all sessions of an
         * always-on account share it, and a session that is not in voice clears it when it
         * connects or closes. The session that is in voice sets it again.
         */
        ownVoiceMarkerChanged(value) {
            if (this.voice.state !== 'connected' && this.voice.state !== 'reconnecting') return;
            const marker = typeof value === 'string' ? value.trim() : '';
            // A call publishes no marker, so an empty one is right there
            const expected = this.voice.kind === 'channel' ? this.voice.channel : '';
            if (sameChannel(marker, expected)) return;
            const now = Date.now();
            reassertTimes = reassertTimes.filter(time => now - time < 60000);
            if (reassertTimes.length >= VOICE_REASSERT_LIMIT) return;
            reassertTimes.push(now);
            this.syncOwnVoice();
        },

        /** Closing the page: clear the marker before QUIT (always-on keeps metadata). */
        voicePageHide() {
            if (this.voice.state === 'idle') return;
            if (this.supportsMetadata && this.canSendChat?.()) this.sendRaw(`METADATA * SET ${VOICE_METADATA_KEY}`);
        },

        userInVoice(user, channel = this.currentChannel) {
            return Boolean(user?.voice) && sameChannel(user.voice, channel);
        },

        // Controls

        async toggleVoiceMute() {
            this.voice.micMuted = !this.voice.micMuted;
            this.playVoiceSoundFor(this.voice.micMuted ? 'mute' : 'unmute');
            await voiceSession?.setMicMuted(this.voice.micMuted);
        },

        async toggleVoiceDeafen() {
            this.voice.deafened = !this.voice.deafened;
            this.playVoiceSoundFor(this.voice.deafened ? 'mute' : 'unmute');
            await voiceSession?.setDeafened(this.voice.deafened);
        },

        /**
         * Plays a voice chat sound on the chosen output. Sounds about others stay silent
         * while deafened, the own ones (mute, join, leave) always play.
         */
        playVoiceSoundFor(name, { others = false } = {}) {
            if (!this.voiceSettings.sounds) return;
            if (others && this.voice.deafened) return;
            this._playVoiceSound(name, { sinkId: this.voiceSettings.outputDeviceId });
        },

        async enableVoiceAudio() {
            await voiceSession?.startAudio().catch(() => {});
        },

        voiceParticipantVolume(identity) {
            return Math.round((this.voiceSettings.volumes[identity] ?? 1) * 100);
        },

        setVoiceParticipantVolume(identity, percent) {
            const volume = Math.min(1, Math.max(0, Number(percent) / 100));
            this.voiceSettings.volumes = { ...this.voiceSettings.volumes, [identity]: volume };
            writeVoiceSettings(this.voiceSettings);
            voiceSession?.setParticipantVolume(identity, volume);
        },

        toggleVoiceVolumeMenu(identity) {
            this.voice.volumeFor = this.voice.volumeFor === identity ? null : identity;
        },

        voiceStateLabel() {
            // While a call rings, the calls module says who is being called
            if (this.voiceCall?.state === 'ringing' && this.voiceCallLabel) return this.voiceCallLabel();
            const keys = { connecting: 'voice_connecting', connected: 'voice_connected', reconnecting: 'voice_reconnecting' };
            return keys[this.voice.state] ? this.t(keys[this.voice.state]) : '';
        },

        voicePttHint() {
            return this.voiceSettings.mode === 'ptt' ? this.t('voice_ptt_hint', { key: this.voiceSettings.pttKey }) : '';
        },

        voiceLevelPercent(level) {
            return levelToPercent(level);
        },

        voiceThresholdPercent() {
            return levelToPercent(this.voiceSettings.thresholdDb);
        },

        // Push-to-talk

        handleVoiceKey(event, down) {
            if (this.voiceSettings.mode !== 'ptt' || event.code !== this.voiceSettings.pttKey) return;
            if (this.voice.state === 'idle' && !this.voiceTest.running) return;
            event.preventDefault();
            if (event.repeat) return;
            this.setVoicePtt(down);
        },

        setVoicePtt(active) {
            if (this._voicePttDown === active) return;
            this._voicePttDown = active;
            voiceSession?.setGate({ pttActive: active });
            voiceTestPipeline?.setGate({ pttActive: active });
        },

        // Settings

        setVoiceSetting(key, value) {
            this.voiceSettings = { ...this.voiceSettings, [key]: value };
            writeVoiceSettings(this.voiceSettings);

            if (key === 'enabled' && !value) {
                this.leaveVoice();
                this.stopVoiceTest();
            }
            if (key === 'mode') {
                this.setVoicePtt(false);
                voiceSession?.setGate({ mode: value });
                voiceTestPipeline?.setGate({ mode: value });
            }
        },

        setVoiceThresholdPercent(percent) {
            const thresholdDb = Math.round(percentToLevel(percent));
            this.setVoiceSetting('thresholdDb', thresholdDb);
            voiceSession?.setGate({ thresholdDb });
            voiceTestPipeline?.setGate({ thresholdDb });
        },

        async refreshVoiceDevices() {
            try {
                const { listAudioDevices } = await this._voiceModule();
                this.voiceDevices = await listAudioDevices();
            } catch (error) {
                console.warn('[voice] could not list audio devices', error);
                this.voiceDevices = { inputs: [], outputs: [], canSelectOutput: false };
            }
        },

        // Filters offered by the server

        /** Fetches the filter list once; without a voice server or on errors it stays empty. */
        async loadVoiceFilters({ force = false } = {}) {
            if (!this.voiceAvailable()) return this.voiceFilters;
            if (force) filtersRequest = null;
            filtersRequest ??= Promise.all([this.connection.api('chat/voice/filters'), this._voiceModule()])
                .then(async ([response, { usableVoiceFilters }]) => usableVoiceFilters(response.ok ? (await response.json())?.filters : []))
                .catch(error => {
                    console.warn('[voice] could not load the filter list', error);
                    filtersRequest = null;
                    return [];
                });
            this.voiceFilters = await filtersRequest;
            return this.voiceFilters;
        },

        /** Another connection may offer other filters. */
        forgetVoiceFilters() {
            filtersRequest = null;
            this.voiceFilters = [];
        },

        /** The chosen filter if the server still offers it, otherwise null (browser filter). */
        selectedVoiceFilter() {
            const id = this.voiceSettings.noiseFilter;
            return (id && this.voiceFilters.find(filter => filter.id === id)) || null;
        },

        async setVoiceFilter(id) {
            this.setVoiceSetting('noiseFilter', typeof id === 'string' ? id : '');
            if (this.voiceTest.running) {
                this.stopVoiceTest();
                await this.startVoiceTest();
            }
        },

        voiceFilterFailed(error) {
            console.warn('[voice] filter could not be started, using the browser filter', error);
            this.showVoiceNotice(this.t('voice_filter_failed'));
        },

        async setVoiceInput(deviceId) {
            this.setVoiceSetting('inputDeviceId', deviceId);
            if (this.voiceTest.running) {
                this.stopVoiceTest();
                await this.startVoiceTest();
            }
            await voiceSession?.switchInput(deviceId).catch(error => {
                this.showVoiceError(error);
            });
        },

        async setVoiceOutput(deviceId) {
            this.setVoiceSetting('outputDeviceId', deviceId);
            await voiceSession?.switchOutput(deviceId);
        },

        async startVoiceTest() {
            if (this.voiceTest.running) return;
            this.dismissVoiceError();
            try {
                const { MicPipeline } = await this._voiceModule();
                await this.loadVoiceFilters();
                const pipeline = new MicPipeline({
                    deviceId: this.voiceSettings.inputDeviceId,
                    noiseSuppression: this.voiceSettings.noiseSuppression,
                    filter: this.selectedVoiceFilter(),
                    onFilterFailed: error => this.voiceFilterFailed(error),
                    gate: { mode: this.voiceSettings.mode, thresholdDb: this.voiceSettings.thresholdDb },
                    onLevel: (level, open) => { this.voiceTest.level = level; this.voiceTest.open = open; },
                });
                voiceTestPipeline = pipeline;
                this.voiceTest.running = true;
                await pipeline.start();
                // Labels of the devices are only readable after the permission
                await this.refreshVoiceDevices();
            } catch (error) {
                this.stopVoiceTest();
                this.showVoiceError(error);
            }
        },

        stopVoiceTest() {
            voiceTestPipeline?.stop();
            voiceTestPipeline = null;
            this.voiceTest = { running: false, level: -100, open: false };
        },
    };
}

export function registerVoiceSettings(registry) {
    const offered = env => env.hasFeature('voice') && env.hasToken;
    registry.registerSection({ id: 'voice', label: 'settings_section_voice', icon: 'bi-mic', order: 45, when: offered });
    registry.registerSetting({
        id: 'voice.enabled',
        section: 'voice',
        type: 'toggle',
        scope: SCOPE.Device,
        order: 10,
        label: 'settings_voice_enabled',
        hint: 'settings_voice_enabled_hint',
        keywords: ['voice', 'sprachchat', 'mikrofon', 'microphone', 'livekit', 'experimentell', 'experimental'],
        get: chat => Boolean(chat.voiceSettings?.enabled),
        set: (chat, value) => chat.setVoiceSetting('enabled', Boolean(value)),
    });
    registry.registerSetting({
        id: 'voice.mode',
        section: 'voice',
        type: 'select',
        scope: SCOPE.Device,
        order: 20,
        label: 'settings_voice_mode',
        options: [
            { value: 'vad', label: 'settings_voice_mode_vad' },
            { value: 'ptt', label: 'settings_voice_mode_ptt' },
            { value: 'open', label: 'settings_voice_mode_open' },
        ],
        keywords: ['push to talk', 'ptt', 'sprachaktivierung', 'voice activation'],
        get: chat => chat.voiceSettings.mode,
        set: (chat, value) => chat.setVoiceSetting('mode', value),
    });
    registry.registerSetting({
        id: 'voice.pttKey',
        section: 'voice',
        type: 'select',
        scope: SCOPE.Device,
        order: 30,
        label: 'settings_voice_ptt_key',
        hint: 'settings_voice_ptt_key_hint',
        options: VOICE_PTT_KEYS.map(key => ({ value: key, label: key })),
        keywords: ['push to talk', 'ptt', 'taste', 'key'],
        get: chat => chat.voiceSettings.pttKey,
        set: (chat, value) => chat.setVoiceSetting('pttKey', value),
    });
    registry.registerSetting({
        id: 'voice.noiseSuppression',
        section: 'voice',
        type: 'toggle',
        scope: SCOPE.Device,
        order: 40,
        label: 'settings_voice_noise',
        hint: 'settings_voice_noise_hint',
        keywords: ['noise', 'rauschen', 'echo', 'filter'],
        get: chat => chat.voiceSettings.noiseSuppression,
        set: (chat, value) => chat.setVoiceSetting('noiseSuppression', Boolean(value)),
    });
    registry.registerSetting({
        id: 'voice.sounds',
        section: 'voice',
        type: 'toggle',
        scope: SCOPE.Device,
        order: 45,
        label: 'settings_voice_sounds',
        hint: 'settings_voice_sounds_hint',
        keywords: ['ton', 'sound', 'klang', 'beitreten', 'join', 'leave', 'stumm', 'mute'],
        get: chat => chat.voiceSettings.sounds,
        set: (chat, value) => chat.setVoiceSetting('sounds', Boolean(value)),
    });
    registry.registerSetting({
        id: 'voice.devices',
        section: 'voice',
        type: 'custom',
        view: 'voice',
        scope: SCOPE.Device,
        order: 50,
        label: 'settings_voice_devices',
        keywords: ['mikrofon', 'microphone', 'lautsprecher', 'headset', 'test', 'schwelle', 'threshold'],
    });
}

/** @type {import('./index.js').ChatModule} */
export const voiceModule = {
    name: 'voice',
    mixin: voiceMixin,
    register: registerVoiceSettings,
    hooks: {
        init() {
            globalThis.addEventListener?.('keydown', event => this.handleVoiceKey(event, true));
            globalThis.addEventListener?.('keyup', event => this.handleVoiceKey(event, false));
            globalThis.addEventListener?.('blur', () => this.setVoicePtt(false));
        },
        /** Before the socket closes, so the marker is cleared with the connection still up. */
        loggingOut() {
            this.leaveVoice();
        },
        loggedOut() {
            this.forgetVoiceFilters();
        },
        pageHide() {
            this.voicePageHide();
        },
    },
};
