/**
 * Start script of the edition: what it gets, and that it never stops the chat from starting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_START_SCRIPT, runStartScript, startScriptContext } from '../chat/edition-start.mjs';
import { loadEdition } from '../scripts/edition.mjs';

function quietLog() {
    const errors = [];
    return { errors, log: { error: (...args) => errors.push(args) } };
}

const edition = { appName: 'Example Chat', version: '1.2.3' };

test('the context names the shell, the storage scope and whether it is the primary server', () => {
    assert.deepEqual(
        startScriptContext({ profileHash: 'abc', isExternalServer: false, password: 'secret' }, { storageScope: 'abc' }, edition, 'mobile'),
        { shell: 'mobile', appName: 'Example Chat', version: '1.2.3', storageScope: 'abc', primary: true },
    );
    const external = startScriptContext({ isExternalServer: true }, {}, {}, 'desktop');
    assert.equal(external.primary, false);
    assert.equal(external.storageScope, '');
    assert.equal(external.appName, '');
});

test('the script runs with the context and is awaited', async () => {
    const order = [];
    await runStartScript(async (context) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(context.storageScope);
    }, { storageScope: 'abc' });
    order.push('after');
    assert.deepEqual(order, ['abc', 'after']);
});

test('the script cannot change the context for later code', async () => {
    const context = { storageScope: 'abc' };
    const { errors, log } = quietLog();
    await runStartScript((given) => { given.storageScope = 'other'; }, context, { log });
    assert.equal(context.storageScope, 'abc');
    assert.equal(errors.length, 1, 'writing to the frozen copy throws in strict mode and is logged');
});

test('without a script nothing happens', async () => {
    const { errors, log } = quietLog();
    await runStartScript(null, {}, { log });
    await runStartScript(undefined, {}, { log });
    assert.equal(errors.length, 0);
});

test('a default export that is no function is logged', async () => {
    const { errors, log } = quietLog();
    await runStartScript({ run() {} }, {}, { log });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /does not export a function/);
});

test('a failing script is logged and does not reject', async () => {
    const { errors, log } = quietLog();
    await runStartScript(() => { throw new Error('broken'); }, {}, { log });
    await runStartScript(async () => { throw new Error('broken later'); }, {}, { log });
    assert.equal(errors.length, 2);
    assert.equal(errors[1][1].message, 'broken later');
});

test('a script that takes too long is given up', async () => {
    const { errors, log } = quietLog();
    const started = Date.now();
    await runStartScript(() => new Promise(() => {}), {}, { timeoutMs: 30, log });
    assert.ok(Date.now() - started < 1000);
    assert.equal(errors.length, 1);
    assert.match(errors[0][1].message, /longer than 30 ms/);
});

test('the placeholder module exports null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starchat-start-'));
    const file = path.join(dir, 'edition-start.mjs');
    fs.writeFileSync(file, NO_START_SCRIPT);
    const module = await import(`file://${file.replace(/\\/g, '/')}`);
    assert.equal(module.default, null);
});

/** Just the header of a PNG, enough for the size check. */
function fakePng(size) {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(size, 16);
    header.writeUInt32BE(size, 20);
    return header;
}

function editionFolder(json, files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starchat-edition-'));
    fs.writeFileSync(path.join(dir, 'edition.json'), JSON.stringify(json));
    fs.writeFileSync(path.join(dir, 'icon.png'), fakePng(512));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

const base = { appName: 'Example Chat', appId: 'org.example.chat', executableName: 'example-chat', icon: 'icon.png' };

test('the start script is a file inside the edition folder', () => {
    const dir = editionFolder({ ...base, chat: { startScript: 'start.mjs' } }, { 'start.mjs': 'export default () => {};\n' });
    const { files } = loadEdition(dir);
    assert.equal(files['chat.startScript'], path.join(dir, 'start.mjs'));

    assert.throws(() => loadEdition(editionFolder({ ...base, chat: { startScript: 'missing.js' } })), /chat\.startScript: missing\.js does not exist/);
    assert.throws(() => loadEdition(editionFolder({ ...base, chat: { startScript: '../start.js' } })), /outside the edition folder/);
    assert.throws(() => loadEdition(editionFolder({ ...base, chat: { startScript: 'start.ts' } })), /startScript/);
});
