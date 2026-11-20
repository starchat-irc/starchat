'use strict';

/**
 * Over-the-air chat updates: the chat (generated/chat) can be replaced by a newer build from the
 * server without a new installer. The server publishes the chat files and a manifest signed
 * with an ECDSA P-256 key (php artisan electron:build-bundle); the app only accepts a manifest
 * whose signature matches the public key shipped with it and files whose SHA-256 match.
 *
 * - Checked with the app updates (start + hourly), downloaded into userData/chat-bundles/<version>.
 * - Used from the next chat start (new tab, app start), never in a running chat.
 * - A bundle whose chat does not report back (chat-ready) in time is dropped for good and
 *   the chat built into the app is used again.
 * - An app update with a newer built-in chat ignores older bundles; bundles that need a newer
 *   shell (nativeApi) are not installed.
 *
 * Free of Electron imports so it can be unit-tested.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'state.json';
const VERSION_PATTERN = /^[0-9a-f]{12}$/;
const FILE_PATH_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 60 * 1024 * 1024;
const MAX_FILES = 500;

/**
 * The manifest inside a signed envelope {payload, signature}: null unless the signature is
 * valid for the public key and the content is well-formed.
 *
 * @param {string} raw            the manifest.json text
 * @param {string} publicKeyPem   SPKI PEM of the signing key
 * @return {{version: string, nativeApi: number, builtAt: number, files: {path: string, sha256: string, size: number}[]}|null}
 */
function verifySignedManifest(raw, publicKeyPem) {
    let envelope;
    try {
        envelope = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return null;

    let signatureValid = false;
    try {
        signatureValid = crypto.verify('sha256', Buffer.from(envelope.payload, 'utf8'), publicKeyPem, Buffer.from(envelope.signature, 'base64'));
    } catch {
        return null;
    }
    if (!signatureValid) return null;

    let manifest;
    try {
        manifest = JSON.parse(envelope.payload);
    } catch {
        return null;
    }
    return isWellFormed(manifest) ? manifest : null;
}

function isWellFormed(manifest) {
    if (!manifest || !VERSION_PATTERN.test(String(manifest.version))) return false;
    if (!Number.isInteger(manifest.nativeApi) || !Number.isInteger(manifest.builtAt)) return false;
    if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) return false;

    let total = 0;
    const seen = new Set();
    for (const file of manifest.files) {
        if (!file || !FILE_PATH_PATTERN.test(String(file.path)) || seen.has(file.path)) return false;
        if (!SHA256_PATTERN.test(String(file.sha256))) return false;
        if (!Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) return false;
        seen.add(file.path);
        total += file.size;
    }
    return total <= MAX_BUNDLE_BYTES && seen.has('index.html');
}

/**
 * Whether a (verified) manifest describes a chat this app should install.
 *
 * @param {{nativeApi: number, currentBuiltAt: number, installedVersion: ?string, badVersions: string[]}} app
 */
function shouldInstall(manifest, { nativeApi, currentBuiltAt, installedVersion, badVersions }) {
    return Boolean(manifest)
        && manifest.nativeApi <= nativeApi
        && manifest.builtAt > currentBuiltAt
        && manifest.version !== installedVersion
        && !badVersions.includes(manifest.version);
}

/**
 * @param {{
 *   baseDir: string,          userData/chat-bundles
 *   builtInDir: string,       generated/chat inside the app
 *   nativeApi: number,        shell API level of this app (NATIVE_API in main.js)
 *   userAgent?: string,
 *   publicKey: ?string,       SPKI PEM; without a key nothing is ever installed
 *   manifestUrl: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: { info: Function, warn: Function },
 * }} options
 */
function createChatBundleManager({ baseDir, builtInDir, nativeApi, publicKey, manifestUrl, userAgent = 'StarChat', fetchImpl = globalThis.fetch, logger = console }) {
    let checking = false;

    function readState() {
        try {
            const state = JSON.parse(fs.readFileSync(path.join(baseDir, STATE_FILE), 'utf8'));
            return {
                installed: state?.installed && VERSION_PATTERN.test(String(state.installed.version)) ? state.installed : null,
                verified: typeof state?.verified === 'string' ? state.verified : null,
                bad: Array.isArray(state?.bad) ? state.bad.filter(v => typeof v === 'string').slice(-50) : [],
            };
        } catch {
            return { installed: null, verified: null, bad: [] };
        }
    }

    function writeState(state) {
        fs.mkdirSync(baseDir, { recursive: true });
        const file = path.join(baseDir, STATE_FILE);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
        fs.renameSync(`${file}.tmp`, file);
    }

    /** Build time of the chat inside the app (generated/chat/build.json), 0 when unknown. */
    function builtInBuiltAt() {
        try {
            const value = JSON.parse(fs.readFileSync(path.join(builtInDir, 'build.json'), 'utf8'))?.builtAt;
            return Number.isInteger(value) ? value : 0;
        } catch {
            return 0;
        }
    }

    function bundleDir(version) {
        return path.join(baseDir, version);
    }

    /**
     * The chat to load now: the installed bundle when it is newer than the app's own chat
     * and complete, otherwise the built-in chat.
     *
     * @return {{ dir: string, version: ?string, needsConfirmation: boolean }}
     */
    function activeChat() {
        const state = readState();
        const installed = state.installed;
        if (installed) {
            const usable = installed.builtAt > builtInBuiltAt()
                && !state.bad.includes(installed.version)
                && fs.existsSync(path.join(bundleDir(installed.version), 'index.html'));
            if (usable) {
                return { dir: bundleDir(installed.version), version: installed.version, needsConfirmation: state.verified !== installed.version };
            }
            logger.info(`Chat bundle ${installed.version} not used (older than the app or incomplete)`);
            writeState({ ...state, installed: null });
        }
        return { dir: builtInDir, version: null, needsConfirmation: false };
    }

    /** The chat of this bundle came up: keep it. */
    function markReady(version) {
        if (!version) return;
        const state = readState();
        if (state.installed?.version === version && state.verified !== version) {
            writeState({ ...state, verified: version });
            logger.info(`Chat bundle ${version} confirmed`);
        }
    }

    /** The chat of this bundle did not start: never use it again. */
    function markFailed(version) {
        if (!version) return;
        const state = readState();
        logger.warn(`Chat bundle ${version} did not start, back to the built-in chat`);
        writeState({
            installed: state.installed?.version === version ? null : state.installed,
            verified: state.verified === version ? null : state.verified,
            bad: [...new Set([...state.bad, version])],
        });
    }

    async function fetchBuffer(url, maxBytes) {
        const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`${url} is too large`);
        return buffer;
    }

    /** Remove downloads of other versions (the running and the installed one stay). */
    function cleanUp(keep) {
        let entries = [];
        try {
            entries = fs.readdirSync(baseDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || keep.includes(entry.name)) continue;
            try {
                fs.rmSync(path.join(baseDir, entry.name), { recursive: true, force: true });
            } catch (error) {
                logger.warn(`Could not remove old chat bundle ${entry.name}: ${error.message}`);
            }
        }
    }

    /**
     * Look for a newer chat and download it. Resolves to the installed version, or null.
     *
     * @param {{ running?: ?string }} options  version of a chat currently in use (not removed)
     */
    async function checkForUpdate({ running = null } = {}) {
        if (!publicKey || !manifestUrl || checking) return null;
        checking = true;
        let partialDir = null;
        try {
            const manifest = verifySignedManifest((await fetchBuffer(manifestUrl, MAX_MANIFEST_BYTES)).toString('utf8'), publicKey);
            if (!manifest) {
                logger.warn('Chat bundle manifest rejected (signature or content invalid)');
                return null;
            }

            const state = readState();
            const currentBuiltAt = Math.max(builtInBuiltAt(), state.installed?.builtAt || 0);
            if (!shouldInstall(manifest, { nativeApi, currentBuiltAt, installedVersion: state.installed?.version || null, badVersions: state.bad })) {
                return null;
            }

            const fileBase = new URL(`${manifest.version}/`, manifestUrl);
            partialDir = path.join(baseDir, `${manifest.version}.partial`);
            fs.rmSync(partialDir, { recursive: true, force: true });

            for (const file of manifest.files) {
                const content = await fetchBuffer(new URL(file.path, fileBase).href, MAX_FILE_BYTES);
                const hash = crypto.createHash('sha256').update(content).digest('hex');
                if (content.length !== file.size || hash !== file.sha256) {
                    throw new Error(`${file.path} does not match the manifest`);
                }
                const target = path.join(partialDir, ...file.path.split('/'));
                if (path.relative(partialDir, target).startsWith('..')) throw new Error(`Invalid path ${file.path}`);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, content);
            }

            const finalDir = bundleDir(manifest.version);
            fs.rmSync(finalDir, { recursive: true, force: true });
            fs.renameSync(partialDir, finalDir);
            partialDir = null;

            writeState({ ...readState(), installed: { version: manifest.version, builtAt: manifest.builtAt } });
            cleanUp([manifest.version, running].filter(Boolean));
            logger.info(`Chat bundle ${manifest.version} downloaded, used from the next chat start`);
            return manifest.version;
        } catch (error) {
            logger.info(`No chat bundle update: ${error.message}`);
            return null;
        } finally {
            if (partialDir) fs.rmSync(partialDir, { recursive: true, force: true });
            checking = false;
        }
    }

    return { activeChat, markReady, markFailed, checkForUpdate, builtInBuiltAt };
}

module.exports = { createChatBundleManager, verifySignedManifest, shouldInstall };
