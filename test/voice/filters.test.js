/**
 * Microphone filters offered by the server: which ones the chat accepts, how they are loaded.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';

const {
    usableVoiceFilters,
    createVoiceFilterNode,
    voiceFilterSampleRate,
    replacesBrowserNoiseSuppression,
} = await import('../../src/voice/filters.js');

const RNNOISE = { id: 'rnnoise-v1', wasm: 'https://net.example.org/voice-filters/rnnoise-v1/rnnoise.wasm', wasm_simd: 'https://net.example.org/voice-filters/rnnoise-v1/rnnoise_simd.wasm' };

test('only filters the chat knows are offered', () => {
    const filters = usableVoiceFilters([RNNOISE, { id: 'rnnoise-v9', wasm: 'x.wasm' }, { id: 'rnnoise-v1' }, null, 'junk']);

    assert.deepEqual(filters, [{ id: 'rnnoise-v1', name: 'RNNoise', wasm: RNNOISE.wasm, wasmSimd: RNNOISE.wasm_simd }]);
    assert.deepEqual(usableVoiceFilters(undefined), []);
    assert.deepEqual(usableVoiceFilters({ filters: [] }), []);
});

test('RNNoise needs 48 kHz and replaces the noise filter of the browser', () => {
    const [filter] = usableVoiceFilters([RNNOISE]);
    assert.equal(voiceFilterSampleRate(filter), 48000);
    assert.equal(replacesBrowserNoiseSuppression(filter), true);
    assert.equal(voiceFilterSampleRate(null), null);
    assert.equal(replacesBrowserNoiseSuppression(null), false);
});

test('the worklet gets the downloaded binary, which is only fetched once', async () => {
    const fetched = [];
    const previousFetch = globalThis.fetch;
    const previousNode = globalThis.AudioWorkletNode;
    globalThis.fetch = async (url) => {
        fetched.push(url);
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    globalThis.AudioWorkletNode = class {
        constructor(context, name, options) {
            this.name = name;
            this.options = options;
            this.sent = [];
            this.port = { postMessage: message => this.sent.push(message) };
        }
    };
    const modules = [];
    const context = { audioWorklet: { addModule: async url => { modules.push(String(url)); } } };
    const [filter] = usableVoiceFilters([{ ...RNNOISE, wasm_simd: undefined }]);

    try {
        const node = await createVoiceFilterNode(context, filter);
        await createVoiceFilterNode(context, filter);

        assert.equal(node.name, '@sapphi-red/web-noise-suppressor/rnnoise');
        assert.equal(node.options.processorOptions.maxChannels, 1);
        assert.ok(node.options.processorOptions.wasmBinary instanceof ArrayBuffer);
        assert.deepEqual(fetched, [RNNOISE.wasm]);
        assert.match(modules[0], /filters\/rnnoise-v1\.worklet\.js/);

        node.destroy();
        assert.deepEqual(node.sent, ['destroy']);
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.AudioWorkletNode = previousNode;
    }
});

test('a failed download is not cached', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return { ok: false, status: 503 };
    };
    const context = { audioWorklet: { addModule: async () => {} } };
    const filter = { id: 'rnnoise-v1', wasm: 'https://net.example.org/broken.wasm', wasmSimd: null };

    try {
        await assert.rejects(createVoiceFilterNode(context, filter), /HTTP 503/);
        await assert.rejects(createVoiceFilterNode(context, filter), /HTTP 503/);
        assert.equal(calls, 2);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('an unknown filter is refused', async () => {
    await assert.rejects(createVoiceFilterNode({}, { id: 'nope', wasm: 'x' }), /Unknown voice filter/);
});
