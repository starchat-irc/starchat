/**
 * Highlight sounds
 *
 * The built-in sounds are synthesised with Web Audio. An edition can add its own sound
 * file as "app" (labelled with the app name) with registerNotificationSound(). "system"
 * leaves the sound to the operating system's notification, "off" plays nothing.
 */

const BUILT_IN_SOUNDS = ['chime', 'drop', 'ping', 'system', 'off'];

/** Sound names in the order the settings list them. */
export const NOTIFICATION_SOUNDS = [...BUILT_IN_SOUNDS];
let defaultSound = 'chime';

/** Sound files added by the edition, by name. */
const SOUND_FILES = {};
const FILE_VOLUME = 0.7;

/** Highlights arriving in a burst ring once. */
export const NOTIFICATION_SOUND_MIN_INTERVAL_MS = 1500;

const MASTER_GAIN = 0.35;

/** Notes per sound: start offset and length in seconds, frequency in Hz (optionally gliding to `to`). */
const TONES = {
    chime: [
        { start: 0, duration: 0.35, freq: 784, type: 'sine' },
        { start: 0.11, duration: 0.55, freq: 1175, type: 'sine' },
        { start: 0.11, duration: 0.3, freq: 2350, type: 'sine', gain: 0.15 },
    ],
    drop: [
        { start: 0, duration: 0.22, freq: 1500, to: 520, type: 'sine' },
        { start: 0.12, duration: 0.25, freq: 1100, to: 700, type: 'sine', gain: 0.35 },
    ],
    ping: [
        { start: 0, duration: 0.45, freq: 1568, type: 'triangle' },
        { start: 0, duration: 0.2, freq: 3136, type: 'sine', gain: 0.12 },
    ],
};

/**
 * Add the edition's own sound file as "app", listed first.
 *
 * @param {string} url Short wav/mp3/ogg, ideally under one second.
 * @param {{ makeDefault?: boolean }} [options]
 */
export function registerNotificationSound(url, { makeDefault = true } = {}) {
    SOUND_FILES.app = url;
    if (!NOTIFICATION_SOUNDS.includes('app')) NOTIFICATION_SOUNDS.unshift('app');
    if (makeDefault) defaultSound = 'app';
}

export function defaultNotificationSound() {
    return defaultSound;
}

export function normalizeNotificationSound(value) {
    return NOTIFICATION_SOUNDS.includes(value) ? value : defaultSound;
}

/** True when the chat plays the sound itself (and the OS notification has to stay silent). */
export function playsOwnSound(sound) {
    return Boolean(TONES[sound] || SOUND_FILES[sound]);
}

/** One audio element per file, rewound for every play. */
const fileElements = new Map();

function playSoundFile(url) {
    if (typeof globalThis.Audio !== 'function') return false;
    try {
        let element = fileElements.get(url);
        if (!element) {
            element = new globalThis.Audio(url);
            element.preload = 'auto';
            fileElements.set(url, element);
        }
        element.volume = FILE_VOLUME;
        element.currentTime = 0;
        element.play()?.catch?.(() => {});
        return true;
    } catch {
        return false;
    }
}

let sharedContext = null;

function audioContext() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContextClass();
    return sharedContext;
}

/**
 * One note on the given output: start offset and length in seconds, frequency in Hz,
 * optionally gliding to `to`. Also used by the voice chat sounds.
 */
export function scheduleTone(context, output, note) {
    const startAt = context.currentTime + note.start;
    const endAt = startAt + note.duration;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();

    oscillator.type = note.type;
    oscillator.frequency.setValueAtTime(note.freq, startAt);
    if (note.to) oscillator.frequency.exponentialRampToValueAtTime(note.to, startAt + note.duration * 0.6);

    // Fast attack, exponential decay: a soft bell instead of a click
    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.exponentialRampToValueAtTime(note.gain ?? 1, startAt + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);

    oscillator.connect(envelope).connect(output);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.02);
}

/**
 * Plays one of the sounds. Returns false when nothing was played (unknown sound,
 * "system"/"off", or no Web Audio available).
 */
export function playNotificationSound(sound) {
    if (SOUND_FILES[sound]) return playSoundFile(SOUND_FILES[sound]);
    const notes = TONES[sound];
    if (!notes) return false;
    const context = audioContext();
    if (!context) return false;
    try {
        if (context.state === 'suspended') context.resume().catch(() => {});
        const output = context.createGain();
        output.gain.value = MASTER_GAIN;
        output.connect(context.destination);
        notes.forEach(note => scheduleTone(context, output, note));
        return true;
    } catch {
        return false;
    }
}
