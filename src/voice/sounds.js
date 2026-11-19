/**
 * Short sounds of the voice chat: someone joins or leaves, the own mic is muted or back.
 *
 * Synthesised with Web Audio like the highlight sounds (ui/notification-sound.js), on an
 * own context so they can play on the output device chosen for the voice chat.
 */
import { scheduleTone } from '../ui/notification-sound.js';

export const VOICE_SOUNDS = Object.freeze({
    // Rising: someone is here
    join: [
        { start: 0, duration: 0.14, freq: 660, type: 'sine' },
        { start: 0.09, duration: 0.2, freq: 880, type: 'sine' },
    ],
    // Falling: someone is gone
    leave: [
        { start: 0, duration: 0.14, freq: 880, type: 'sine' },
        { start: 0.09, duration: 0.2, freq: 587, type: 'sine' },
    ],
    // Incoming call, repeated while it rings
    ring: [
        { start: 0, duration: 0.18, freq: 784, type: 'sine' },
        { start: 0.2, duration: 0.18, freq: 988, type: 'sine' },
        { start: 0.4, duration: 0.18, freq: 784, type: 'sine' },
        { start: 0.6, duration: 0.3, freq: 988, type: 'sine' },
    ],
    // Short and low: the own mic is off
    mute: [
        { start: 0, duration: 0.08, freq: 420, to: 300, type: 'triangle' },
    ],
    // Short and a bit higher: the own mic is on again
    unmute: [
        { start: 0, duration: 0.08, freq: 520, to: 700, type: 'triangle' },
    ],
});

const VOICE_SOUND_GAIN = 0.25;

/** Arrivals in a burst (e.g. after a server restart) play once. */
export const VOICE_SOUND_MIN_INTERVAL_MS = 500;

let context = null;
let contextSinkId = '';
const lastPlayed = new Map();

function voiceSoundContext(sinkId) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!context || context.state === 'closed') {
        context = new AudioContextClass();
        contextSinkId = '';
    }
    const wanted = sinkId || '';
    if (wanted !== contextSinkId && typeof context.setSinkId === 'function') {
        contextSinkId = wanted;
        context.setSinkId(wanted).catch(() => { contextSinkId = ''; });
    }
    return context;
}

/**
 * Plays one of VOICE_SOUNDS. Returns false when nothing was played (unknown sound,
 * played a moment ago, or no Web Audio).
 *
 * @param {string} name
 * @param {{ sinkId?: string, now?: number }} [options]  sinkId: output device of the voice chat
 */
export function playVoiceSound(name, { sinkId = '', now = Date.now() } = {}) {
    const notes = VOICE_SOUNDS[name];
    if (!notes) return false;
    if (now - (lastPlayed.get(name) ?? -Infinity) < VOICE_SOUND_MIN_INTERVAL_MS) return false;

    const audio = voiceSoundContext(sinkId);
    if (!audio) return false;
    lastPlayed.set(name, now);
    try {
        if (audio.state === 'suspended') audio.resume().catch(() => {});
        const output = audio.createGain();
        output.gain.value = VOICE_SOUND_GAIN;
        output.connect(audio.destination);
        notes.forEach(note => scheduleTone(audio, output, note));
        return true;
    } catch {
        return false;
    }
}
