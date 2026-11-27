/**
 * Start script of the mobile edition: the build only takes a file inside the edition folder.
 * How it runs is tested in desktop/test/edition-start.test.mjs, the chat pages share the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEdition } from '../scripts/edition.mjs';

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

const base = { appName: 'Example Chat', appId: 'org.example.chat', icon: 'icon.png' };

test('the start script is a file inside the edition folder', () => {
    const dir = editionFolder({ ...base, chat: { startScript: 'start.js' } }, { 'start.js': 'export default () => {};\n' });
    const { files } = loadEdition(dir);
    assert.equal(files['chat.startScript'], path.join(dir, 'start.js'));

    assert.throws(() => loadEdition(editionFolder({ ...base, chat: { startScript: 'missing.mjs' } })), /chat\.startScript: missing\.mjs does not exist/);
    assert.throws(() => loadEdition(editionFolder({ ...base, chat: { startScript: '../start.js' } })), /outside the edition folder/);
    assert.throws(() => loadEdition(editionFolder({ ...base, chat: { startScript: 'start.ts' } })), /startScript/);
});
