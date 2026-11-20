/**
 * Electron over-the-air chat updates: signature, hashes, install, rollback.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bundles from '../chat-bundles.js';

const { createChatBundleManager, verifySignedManifest, shouldInstall } = bundles;

const MANIFEST_URL = 'https://st-city.test/electron-chat/manifest.json';
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const otherKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

let workDir;
let builtInDir;
let baseDir;
let served;
let requested;
const silent = { info() {}, warn() {} };

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/** Publish a chat on the fake server, signed like electron:build-bundle does (DER ECDSA over the payload). */
function publish({ version = 'abcdef012345', builtAt = 2000, nativeApi = 1, files = { 'index.html': '<h1>neu</h1>', 'assets/chat.js': 'chat()' }, signWith = keys.privateKey, tamper = null } = {}) {
    const manifest = {
        version,
        nativeApi,
        builtAt,
        files: Object.entries(files).map(([filePath, content]) => ({ path: filePath, sha256: sha256(content), size: Buffer.byteLength(content) })),
    };
    const payload = JSON.stringify(manifest);
    const signature = crypto.sign('sha256', Buffer.from(payload), signWith).toString('base64');
    served.set(MANIFEST_URL, JSON.stringify({ payload: tamper ? tamper(payload) : payload, signature }));
    for (const [filePath, content] of Object.entries(files)) {
        served.set(`https://st-city.test/electron-chat/${version}/${filePath}`, content);
    }
    return manifest;
}

async function fakeFetch(url) {
    requested.push(url);
    if (!served.has(url)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(served.get(url));
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
}

function manager(overrides = {}) {
    return createChatBundleManager({
        baseDir,
        builtInDir,
        nativeApi: 1,
        publicKey,
        manifestUrl: MANIFEST_URL,
        fetchImpl: fakeFetch,
        logger: silent,
        ...overrides,
    });
}

beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bundles-'));
    builtInDir = path.join(workDir, 'chat-dist');
    baseDir = path.join(workDir, 'userData', 'chat-bundles');
    fs.mkdirSync(builtInDir, { recursive: true });
    fs.writeFileSync(path.join(builtInDir, 'index.html'), '<h1>eingebaut</h1>');
    fs.writeFileSync(path.join(builtInDir, 'build.json'), JSON.stringify({ builtAt: 1000 }));
    served = new Map();
    requested = [];
});

afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

test('a signed, newer chat is downloaded and used from the next chat start', async () => {
    publish();
    const bundles = manager();
    assert.equal(bundles.activeChat().dir, builtInDir);

    assert.equal(await bundles.checkForUpdate(), 'abcdef012345');

    const active = bundles.activeChat();
    assert.equal(active.version, 'abcdef012345');
    assert.equal(active.needsConfirmation, true);
    assert.equal(fs.readFileSync(path.join(active.dir, 'index.html'), 'utf8'), '<h1>neu</h1>');
    assert.equal(fs.readFileSync(path.join(active.dir, 'assets', 'chat.js'), 'utf8'), 'chat()');

    bundles.markReady('abcdef012345');
    assert.equal(bundles.activeChat().needsConfirmation, false);
});

test('a manifest signed with another key is ignored', async () => {
    publish({ signWith: otherKeys.privateKey });
    assert.equal(await manager().checkForUpdate(), null);
    assert.equal(requested.length, 1, 'no chat file is downloaded');
});

test('a changed manifest no longer matches its signature', async () => {
    publish({ tamper: payload => payload.replace('"nativeApi":1', '"nativeApi":0') });
    assert.equal(await manager().checkForUpdate(), null);
});

test('a file that does not match its hash leaves nothing installed', async () => {
    publish();
    served.set('https://st-city.test/electron-chat/abcdef012345/assets/chat.js', 'evil()');

    const bundles = manager();
    assert.equal(await bundles.checkForUpdate(), null);
    assert.equal(bundles.activeChat().dir, builtInDir);
    assert.equal(fs.existsSync(path.join(baseDir, 'abcdef012345')), false);
    assert.equal(fs.existsSync(path.join(baseDir, 'abcdef012345.partial')), false);
});

test('paths leaving the bundle folder are refused even when signed', async () => {
    publish({ files: { 'index.html': 'x', '../evil.js': 'boom' } });
    assert.equal(await manager().checkForUpdate(), null);
    assert.equal(fs.existsSync(path.join(workDir, 'userData', 'evil.js')), false);
});

test('without a public key nothing is ever downloaded', async () => {
    publish();
    assert.equal(await manager({ publicKey: null }).checkForUpdate(), null);
    assert.equal(requested.length, 0);
});

test('bundles for a newer shell or older than the app chat are not installed', async () => {
    publish({ nativeApi: 2 });
    assert.equal(await manager().checkForUpdate(), null);

    publish({ builtAt: 900 });
    assert.equal(await manager().checkForUpdate(), null);
});

test('an app update with a newer built-in chat drops an older bundle', async () => {
    publish({ builtAt: 2000 });
    const bundles = manager();
    await bundles.checkForUpdate();
    bundles.markReady('abcdef012345');

    fs.writeFileSync(path.join(builtInDir, 'build.json'), JSON.stringify({ builtAt: 3000 }));

    assert.equal(bundles.activeChat().dir, builtInDir);
    assert.equal(bundles.activeChat().version, null);
});

test('a chat that did not start is never used or downloaded again', async () => {
    publish();
    const bundles = manager();
    await bundles.checkForUpdate();

    bundles.markFailed('abcdef012345');
    assert.equal(bundles.activeChat().dir, builtInDir);

    requested = [];
    assert.equal(await bundles.checkForUpdate(), null);
    assert.equal(requested.length, 1, 'only the manifest was asked for');
});

test('an unchanged version is not downloaded twice and old versions are removed', async () => {
    publish({ version: 'aaaaaaaaaaaa', builtAt: 2000 });
    const bundles = manager();
    await bundles.checkForUpdate();

    requested = [];
    assert.equal(await bundles.checkForUpdate(), null);
    assert.equal(requested.length, 1);

    publish({ version: 'bbbbbbbbbbbb', builtAt: 3000, files: { 'index.html': 'v3' } });
    assert.equal(await bundles.checkForUpdate({ running: null }), 'bbbbbbbbbbbb');
    assert.equal(fs.existsSync(path.join(baseDir, 'aaaaaaaaaaaa')), false);
    assert.equal(bundles.activeChat().version, 'bbbbbbbbbbbb');
});

test('the chat in use is kept when a newer one arrives', async () => {
    publish({ version: 'aaaaaaaaaaaa', builtAt: 2000 });
    const bundles = manager();
    await bundles.checkForUpdate();

    publish({ version: 'bbbbbbbbbbbb', builtAt: 3000, files: { 'index.html': 'v3' } });
    await bundles.checkForUpdate({ running: 'aaaaaaaaaaaa' });
    assert.equal(fs.existsSync(path.join(baseDir, 'aaaaaaaaaaaa', 'index.html')), true);
});

test('the manifest check rejects broken envelopes and contents', () => {
    const sign = (payload) => JSON.stringify({ payload, signature: crypto.sign('sha256', Buffer.from(payload), keys.privateKey).toString('base64') });

    assert.equal(verifySignedManifest('not json', publicKey), null);
    assert.equal(verifySignedManifest(JSON.stringify({ payload: '{}' }), publicKey), null);
    assert.equal(verifySignedManifest(sign('{"version":"x"}'), publicKey), null);
    assert.equal(verifySignedManifest(sign(JSON.stringify({ version: 'abcdef012345', nativeApi: 1, builtAt: 1, files: [{ path: 'a.js', sha256: 'f'.repeat(64), size: 1 }] })), publicKey), null, 'index.html is required');
    assert.ok(verifySignedManifest(sign(JSON.stringify({ version: 'abcdef012345', nativeApi: 1, builtAt: 1, files: [{ path: 'index.html', sha256: 'f'.repeat(64), size: 1 }] })), publicKey));
});

test('shouldInstall compares shell level, age, installed and broken versions', () => {
    const manifest = { version: 'abcdef012345', nativeApi: 1, builtAt: 2000 };
    const app = { nativeApi: 1, currentBuiltAt: 1000, installedVersion: null, badVersions: [] };
    assert.equal(shouldInstall(manifest, app), true);
    assert.equal(shouldInstall(manifest, { ...app, installedVersion: 'abcdef012345' }), false);
    assert.equal(shouldInstall(manifest, { ...app, badVersions: ['abcdef012345'] }), false);
    assert.equal(shouldInstall(manifest, { ...app, currentBuiltAt: 2000 }), false);
    assert.equal(shouldInstall({ ...manifest, nativeApi: 2 }, app), false);
});

test('a DER signature (openssl_sign, Node default) of the manifest verifies', () => {
    const payload = JSON.stringify({ version: 'abcdef012345', nativeApi: 1, builtAt: 1, files: [{ path: 'index.html', sha256: 'f'.repeat(64), size: 1 }] });
    const signature = crypto.sign('sha256', Buffer.from(payload), keys.privateKey).toString('base64');

    assert.ok(verifySignedManifest(JSON.stringify({ payload, signature }), publicKey));
});
