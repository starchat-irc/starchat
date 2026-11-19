/**
 * Microphone filters offered by the server (GET chat/voice/filters, see docs/discovery.md).
 *
 * A filter is split in two halves that are versioned together through its id:
 *  - the AudioWorklet ships with the chat (CSP of the desktop app: no scripts from servers),
 *  - the large WebAssembly files come from the server and are only loaded on use.
 * The chat offers a filter only if it knows the id and the server lists it. A new build
 * of a filter gets a new id (rnnoise-v2), so older chats keep loading their version.
 */

/** Filters this chat can run, by id. */
export const KNOWN_VOICE_FILTERS = Object.freeze({
    'rnnoise-v1': Object.freeze({
        name: 'RNNoise',
        processor: '@sapphi-red/web-noise-suppressor/rnnoise',
        worklet: new URL('./filters/rnnoise-v1.worklet.js', import.meta.url),
        sampleRate: 48000,
        // Replaces the noise filter of the browser, echo cancellation stays
        replacesBrowserNoiseSuppression: true,
    }),
});

/**
 * Entries of the server list that this chat can run, with the local half merged in.
 *
 * @param {unknown} list  `filters` of the server response
 * @returns {{ id: string, name: string, wasm: string, wasmSimd: string|null }[]}
 */
export function usableVoiceFilters(list) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(entry => entry && typeof entry.id === 'string' && KNOWN_VOICE_FILTERS[entry.id] && typeof entry.wasm === 'string')
        .map(entry => ({
            id: entry.id,
            name: KNOWN_VOICE_FILTERS[entry.id].name,
            wasm: entry.wasm,
            wasmSimd: typeof entry.wasm_simd === 'string' ? entry.wasm_simd : null,
        }));
}

/** Smallest module that uses a SIMD instruction (same check as wasm-feature-detect). */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

function supportsSimd() {
    try {
        return WebAssembly.validate(SIMD_PROBE);
    } catch {
        return false;
    }
}

/** Downloaded WebAssembly per URL: rejoining or a mic test does not load it again. */
const binaries = new Map();

async function loadBinary(url) {
    if (!binaries.has(url)) {
        const request = fetch(url, { credentials: 'omit' }).then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return response.arrayBuffer();
        });
        binaries.set(url, request);
        request.catch(() => binaries.delete(url));
    }
    return binaries.get(url);
}

/** Sample rate the AudioContext needs for this filter, or null for any. */
export function voiceFilterSampleRate(filter) {
    return KNOWN_VOICE_FILTERS[filter?.id]?.sampleRate ?? null;
}

export function replacesBrowserNoiseSuppression(filter) {
    return Boolean(KNOWN_VOICE_FILTERS[filter?.id]?.replacesBrowserNoiseSuppression);
}

/**
 * Builds the worklet node of a filter in the given context.
 *
 * @param {AudioContext} context
 * @param {{ id: string, wasm: string, wasmSimd: string|null }} filter
 * @returns {Promise<AudioWorkletNode & { destroy: () => void }>}
 */
export async function createVoiceFilterNode(context, filter) {
    const known = KNOWN_VOICE_FILTERS[filter?.id];
    if (!known) throw new Error(`Unknown voice filter ${filter?.id}`);

    const url = filter.wasmSimd && supportsSimd() ? filter.wasmSimd : filter.wasm;
    const [wasmBinary] = await Promise.all([loadBinary(url), context.audioWorklet.addModule(known.worklet)]);
    // The binary is copied into the worklet, the cached one stays usable
    const node = new AudioWorkletNode(context, known.processor, {
        processorOptions: { maxChannels: 1, wasmBinary },
    });
    node.destroy = () => node.port.postMessage('destroy');
    return node;
}
