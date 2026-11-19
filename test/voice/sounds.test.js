/**
 * Voice chat sounds: which ones exist, the burst limit and the output device.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

const created = [];
class FakeAudioContext {
    constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
        this.sinks = [];
        this.oscillators = 0;
        created.push(this);
    }
    setSinkId(id) { this.sinks.push(id); return Promise.resolve(); }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: target => target }; }
    createOscillator() {
        this.oscillators++;
        return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: target => target, start() {}, stop() {} };
    }
}
globalThis.AudioContext = FakeAudioContext;

const { playVoiceSound, VOICE_SOUNDS, VOICE_SOUND_MIN_INTERVAL_MS } = await import('../../src/voice/sounds.js');

test('join, leave, ring, mute and unmute exist, unknown names play nothing', () => {
    assert.deepEqual(Object.keys(VOICE_SOUNDS), ['join', 'leave', 'ring', 'mute', 'unmute']);
    assert.equal(playVoiceSound('nope', { now: 1 }), false);
});

test('a burst of the same sound plays once, different sounds are independent', () => {
    const start = 1_000_000;
    assert.equal(playVoiceSound('join', { now: start }), true);
    assert.equal(playVoiceSound('join', { now: start + 100 }), false);
    assert.equal(playVoiceSound('leave', { now: start + 100 }), true);
    assert.equal(playVoiceSound('join', { now: start + VOICE_SOUND_MIN_INTERVAL_MS }), true);
    assert.ok(created[0].oscillators >= VOICE_SOUNDS.join.length * 2 + VOICE_SOUNDS.leave.length);
});

test('plays on the output device of the voice chat and switches only when it changes', () => {
    const start = 2_000_000;
    playVoiceSound('mute', { now: start, sinkId: 'headset' });
    playVoiceSound('unmute', { now: start, sinkId: 'headset' });
    playVoiceSound('mute', { now: start + 1000, sinkId: '' });

    assert.equal(created.length, 1, 'one shared context');
    assert.deepEqual(created[0].sinks, ['headset', '']);
});
