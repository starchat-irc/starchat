/**
 * Voice session (experimental)
 *
 * Wraps one LiveKit room for the voice chat of an IRC channel. The microphone runs
 * through an own Web Audio graph before it is published:
 *
 *   getUserMedia (browser echo/noise filters) → [server filter, e.g. RNNoise] → voice gate worklet → published track
 *
 * so voice activation, push-to-talk and mute happen before anything leaves the device.
 * livekit-client is imported lazily: the chat bundle stays small for everyone who
 * never joins a voice chat.
 */

import { createVoiceFilterNode, replacesBrowserNoiseSuppression, voiceFilterSampleRate } from './filters.js';

const GATE_WORKLET_URL = new URL('./gate.worklet.js', import.meta.url);

export { VOICE_MODES, VOICE_PTT_KEYS, METER_MIN_DB, METER_MAX_DB, levelToPercent, percentToLevel } from './levels.js';
export { usableVoiceFilters } from './filters.js';

/**
 * Microphone → gate → MediaStreamTrack. Also used alone for the mic test in the settings.
 */
export class MicPipeline {
    /**
     * @param {{
     *   deviceId?: string, noiseSuppression?: boolean, gate?: object,
     *   filter?: { id: string, wasm: string, wasmSimd: string|null }|null,
     *   onLevel?: (db: number, open: boolean) => void,
     *   onFilterFailed?: (error: Error) => void,
     * }} options
     */
    constructor(options = {}) {
        this.options = options;
        this.gateParams = { mode: 'vad', thresholdDb: -50, pttActive: false, muted: false, ...(options.gate || {}) };
        this.stream = null;
        this.context = null;
        this.node = null;
        this.filterNode = null;
        this.destination = null;
        /** The filter that really runs, null without one or after a failed load. */
        this.activeFilter = null;
    }

    async start() {
        const browserFilters = this.options.noiseSuppression !== false;
        const filter = this.options.filter || null;
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: this.options.deviceId ? { exact: this.options.deviceId } : undefined,
                echoCancellation: browserFilters,
                noiseSuppression: browserFilters && !replacesBrowserNoiseSuppression(filter),
                autoGainControl: browserFilters,
                channelCount: 1,
            },
            video: false,
        });

        let source = filter ? await this.startFilter(filter) : null;
        if (!source) {
            this.context = new AudioContext({ latencyHint: 'interactive' });
            source = this.context.createMediaStreamSource(this.stream);
        }
        await this.context.audioWorklet.addModule(GATE_WORKLET_URL);
        this.node = new AudioWorkletNode(this.context, 'starchat-voice-gate', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
        });
        this.node.port.onmessage = (event) => this.options.onLevel?.(event.data.level, event.data.open);
        this.node.port.postMessage(this.gateParams);
        this.destination = this.context.createMediaStreamDestination();
        source.connect(this.node).connect(this.destination);
        if (this.context.state === 'suspended') await this.context.resume().catch(() => {});
        return this;
    }

    /**
     * Context and source with the filter in front. On failure the mic runs without it
     * (browser noise filter switched back on) and onFilterFailed reports why.
     *
     * @returns {Promise<AudioNode|null>} null if the filter could not be started
     */
    async startFilter(filter) {
        const sampleRate = voiceFilterSampleRate(filter);
        try {
            this.context = new AudioContext({ latencyHint: 'interactive', ...(sampleRate ? { sampleRate } : {}) });
            const source = this.context.createMediaStreamSource(this.stream);
            this.filterNode = await createVoiceFilterNode(this.context, filter);
            source.connect(this.filterNode);
            this.activeFilter = filter;
            return this.filterNode;
        } catch (error) {
            this.filterNode?.destroy();
            this.filterNode = null;
            this.context?.close().catch(() => {});
            this.context = null;
            if (this.options.noiseSuppression !== false && replacesBrowserNoiseSuppression(filter)) {
                await this.stream.getAudioTracks()[0]?.applyConstraints({ noiseSuppression: true }).catch(() => {});
            }
            this.options.onFilterFailed?.(error);
            return null;
        }
    }

    get track() {
        return this.destination?.stream.getAudioTracks()[0] || null;
    }

    setGate(params) {
        Object.assign(this.gateParams, params);
        this.node?.port.postMessage(params);
    }

    stop() {
        this.stream?.getTracks().forEach(track => track.stop());
        this.node?.disconnect();
        this.filterNode?.destroy();
        this.filterNode?.disconnect();
        this.context?.close().catch(() => {});
        this.stream = this.context = this.node = this.filterNode = this.destination = null;
        this.activeFilter = null;
    }
}

/**
 * @typedef {Object} VoiceParticipant
 * @property {string} identity  account on the network
 * @property {string} name      IRC nick at join time
 * @property {boolean} isLocal
 * @property {boolean} isSpeaking
 * @property {boolean} isMuted
 */

/**
 * @param {{
 *   url: string, token: string,
 *   settings: { mode: string, thresholdDb: number, noiseSuppression: boolean, inputDeviceId: string, outputDeviceId: string },
 *   volumes: Record<string, number>,
 *   filter?: { id: string, wasm: string, wasmSimd: string|null }|null,
 *   onFilterFailed?: (error: Error) => void,
 *   onParticipantEvent?: (kind: 'joined'|'left', identity: string) => void,
 *   onState: (state: 'connecting'|'connected'|'reconnecting'|'disconnected', detail?: string) => void,
 *   onParticipants: (participants: VoiceParticipant[]) => void,
 *   onLevel: (db: number, open: boolean) => void,
 *   onAudioBlocked: (blocked: boolean) => void,
 * }} options
 */
export async function createVoiceSession(options) {
    const { Room, RoomEvent, Track, AudioPresets, ConnectionState } = await import('livekit-client');

    const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        disconnectOnPageLeave: true,
        audioOutput: options.settings.outputDeviceId ? { deviceId: options.settings.outputDeviceId } : undefined,
    });
    const audioContainer = document.createElement('div');
    audioContainer.hidden = true;
    audioContainer.dataset.voiceAudio = '';
    document.body.appendChild(audioContainer);

    let pipeline = null;
    let localPublication = null;
    let localOpen = false;
    let deafened = false;
    let micMuted = false;
    const volumes = { ...(options.volumes || {}) };

    const micPublication = participant => participant.getTrackPublication(Track.Source.Microphone);

    function emitParticipants() {
        const speaking = new Set(room.activeSpeakers.map(participant => participant.identity));
        // The mic starts before the connection: without an identity there is nobody to show yet
        const list = [room.localParticipant, ...room.remoteParticipants.values()]
            .filter(participant => participant?.identity)
            .map(participant => {
                const isLocal = participant === room.localParticipant;
                const publication = micPublication(participant);
                return {
                    identity: participant.identity,
                    name: participant.name || participant.identity,
                    isLocal,
                    isSpeaking: isLocal ? localOpen && !micMuted : speaking.has(participant.identity),
                    isMuted: isLocal ? micMuted : (!publication || publication.isMuted),
                };
            })
            .sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name));
        options.onParticipants(list);
    }

    /**
     * Arrivals and departures of others for the join/leave sounds. Participants who were
     * there before we joined, and anything during a reconnect, are no real arrivals.
     */
    const knownParticipants = new Set();
    let announceParticipants = false;

    function syncKnownParticipants() {
        knownParticipants.clear();
        room.remoteParticipants.forEach(participant => knownParticipants.add(participant.identity));
    }

    function participantJoined(participant) {
        emitParticipants();
        const identity = participant?.identity;
        if (!identity || knownParticipants.has(identity)) return;
        knownParticipants.add(identity);
        if (announceParticipants) options.onParticipantEvent?.('joined', identity);
    }

    function participantLeft(participant) {
        emitParticipants();
        if (!announceParticipants) return;
        if (knownParticipants.delete(participant?.identity)) options.onParticipantEvent?.('left', participant.identity);
    }

    function applyVolume(participant) {
        const volume = deafened ? 0 : (volumes[participant.identity] ?? 1);
        participant.setVolume(volume);
    }

    room
        .on(RoomEvent.ParticipantConnected, participantJoined)
        .on(RoomEvent.ParticipantDisconnected, participantLeft)
        .on(RoomEvent.ActiveSpeakersChanged, emitParticipants)
        .on(RoomEvent.TrackMuted, emitParticipants)
        .on(RoomEvent.TrackUnmuted, emitParticipants)
        .on(RoomEvent.TrackPublished, emitParticipants)
        .on(RoomEvent.TrackUnpublished, emitParticipants)
        .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === Track.Kind.Audio) {
                audioContainer.appendChild(track.attach());
                applyVolume(participant);
            }
            emitParticipants();
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(element => element.remove());
            emitParticipants();
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => options.onAudioBlocked(!room.canPlaybackAudio))
        .on(RoomEvent.ConnectionStateChanged, (state) => {
            if (state === ConnectionState.Connected) {
                // Back after a reconnect: whoever is there now counts as known, silently
                if (!announceParticipants && localPublication) {
                    syncKnownParticipants();
                    announceParticipants = true;
                }
                options.onState('connected');
            } else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
                announceParticipants = false;
                options.onState('reconnecting');
            }
        })
        .on(RoomEvent.Disconnected, (reason) => {
            cleanup();
            options.onState('disconnected', reason);
        });

    function cleanup() {
        pipeline?.stop();
        pipeline = null;
        localPublication = null;
        audioContainer.remove();
    }

    async function startMicrophone() {
        const next = new MicPipeline({
            deviceId: options.settings.inputDeviceId,
            noiseSuppression: options.settings.noiseSuppression,
            filter: options.filter || null,
            onFilterFailed: error => options.onFilterFailed?.(error),
            gate: { mode: options.settings.mode, thresholdDb: options.settings.thresholdDb, muted: micMuted || deafened },
            onLevel: (db, open) => {
                if (open !== localOpen) {
                    localOpen = open;
                    emitParticipants();
                }
                options.onLevel(db, open);
            },
        });
        await next.start();
        return next;
    }

    const session = {
        room,

        async connect() {
            options.onState('connecting');
            // Microphone first: a denied permission fails before anyone sees us joining
            pipeline = await startMicrophone();
            try {
                await room.connect(options.url, options.token, { autoSubscribe: true });
                localPublication = await room.localParticipant.publishTrack(pipeline.track, {
                    name: 'microphone',
                    source: Track.Source.Microphone,
                    audioPreset: AudioPresets.speech,
                    dtx: true,
                    red: true,
                });
            } catch (error) {
                await room.disconnect().catch(() => {});
                cleanup();
                // The microphone works – it is the voice server that failed
                if (error && typeof error === 'object') error.voicePhase = 'connect';
                throw error;
            }
            options.onAudioBlocked(!room.canPlaybackAudio);
            syncKnownParticipants();
            announceParticipants = true;
            emitParticipants();
        },

        async disconnect() {
            await room.disconnect();
            cleanup();
        },

        async setMicMuted(muted) {
            micMuted = Boolean(muted);
            pipeline?.setGate({ muted: micMuted || deafened });
            // Mute the publication too, so the others see the muted icon
            if (localPublication) await (micMuted || deafened ? localPublication.mute() : localPublication.unmute());
            emitParticipants();
        },

        async setDeafened(value) {
            deafened = Boolean(value);
            room.remoteParticipants.forEach(applyVolume);
            await session.setMicMuted(micMuted);
        },

        setGate(params) {
            pipeline?.setGate(params);
        },

        setParticipantVolume(identity, volume) {
            volumes[identity] = volume;
            const participant = room.remoteParticipants.get(identity);
            if (participant) applyVolume(participant);
        },

        async switchInput(deviceId) {
            options.settings.inputDeviceId = deviceId;
            if (!pipeline || !localPublication?.track) return;
            const previous = pipeline;
            pipeline = await startMicrophone();
            await localPublication.track.replaceTrack(pipeline.track, true);
            previous.stop();
        },

        async switchOutput(deviceId) {
            options.settings.outputDeviceId = deviceId;
            return room.switchActiveDevice('audiooutput', deviceId || 'default').catch(() => false);
        },

        async startAudio() {
            await room.startAudio();
            options.onAudioBlocked(!room.canPlaybackAudio);
        },
    };

    return session;
}

/** Microphones and speakers; labels only appear after the permission was granted once. */
export async function listAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], canSelectOutput: false };
    const devices = await navigator.mediaDevices.enumerateDevices();
    const pick = kind => devices
        .filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
        .map((device, index) => ({ id: device.deviceId, label: device.label || `${kind === 'audioinput' ? 'Mic' : 'Output'} ${index + 1}` }));
    return {
        inputs: pick('audioinput'),
        outputs: pick('audiooutput'),
        canSelectOutput: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    };
}
