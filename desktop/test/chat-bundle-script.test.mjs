/**
 * scripts/chat-bundle.mjs: the signed chat update must be accepted by the app (chat-bundles.js).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatBundle, MANIFEST } from '../scripts/chat-bundle.mjs';
import bundles from '../chat-bundles.js';

const { verifySignedManifest } = bundles;
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });

let chatDir;
let outDir;

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starchat-bundle-'));
    chatDir = path.join(root, 'chat');
    outDir = path.join(root, 'out');
    fs.mkdirSync(path.join(chatDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(chatDir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(chatDir, 'assets', 'index-abc.js'), 'console.log(1)');
    fs.writeFileSync(path.join(chatDir, 'build.json'), JSON.stringify({ builtAt: 1 }));
});

const build = (now = () => 5000) => createChatBundle({ chatDir, outDir, privateKeyPem, nativeApi: 1, now });

test('the app accepts the manifest and finds every file with its hash', () => {
    const manifest = build();
    const verified = verifySignedManifest(fs.readFileSync(path.join(outDir, MANIFEST), 'utf8'), publicKeyPem);
    assert.deepEqual(verified, manifest);
    assert.equal(manifest.builtAt, 5000);
    assert.deepEqual(manifest.files.map(file => file.path), ['assets/index-abc.js', 'index.html']);
    for (const file of manifest.files) {
        const content = fs.readFileSync(path.join(outDir, manifest.version, file.path));
        assert.equal(crypto.createHash('sha256').update(content).digest('hex'), file.sha256);
        assert.equal(content.length, file.size);
    }
});

test('build.json of the local build is not part of the update', () => {
    const manifest = build();
    assert.ok(!manifest.files.some(file => file.path === 'build.json'));
    assert.ok(!fs.existsSync(path.join(outDir, manifest.version, 'build.json')));
});

test('the same chat gives the same version, a change a new one; old versions are removed', () => {
    const first = build();
    fs.writeFileSync(path.join(chatDir, 'build.json'), JSON.stringify({ builtAt: 2 }));
    assert.equal(build(() => 6000).version, first.version);

    fs.writeFileSync(path.join(chatDir, 'assets', 'index-abc.js'), 'console.log(2)');
    const second = build(() => 7000);
    assert.notEqual(second.version, first.version);
    assert.ok(!fs.existsSync(path.join(outDir, first.version)));
    assert.ok(fs.existsSync(path.join(outDir, second.version, 'index.html')));
});

test('another key is rejected by the app', () => {
    build();
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
    assert.equal(verifySignedManifest(fs.readFileSync(path.join(outDir, MANIFEST), 'utf8'), other), null);
});

test('only ECDSA P-256 keys and real chat pages', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => createChatBundle({ chatDir, outDir, privateKeyPem: rsa, nativeApi: 1 }), /P-256/);
    fs.rmSync(path.join(chatDir, 'index.html'));
    assert.throws(() => build(), /index.html missing/);
});
