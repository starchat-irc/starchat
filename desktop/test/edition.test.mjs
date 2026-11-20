/**
 * Edition of the desktop app: checking the folder, what the app and electron-builder get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builderConfig, loadEdition, runtimeEdition, serverListForBuild } from '../scripts/edition.mjs';
import runtime from '../edition.js';

const { chooseDataDir, directoryEntries, directoryDomainFor, shellTexts, serverListUrl, toDirectoryEntries, createDiscoveryCache, PUBLIC_SERVER_LIST_URL } = runtime;
const desktopDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

/** Just the header of a PNG, enough for the size check. */
function fakePng(width, height) {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
}

function editionFolder(edition, files = { 'icon.png': fakePng(512, 512) }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starchat-edition-'));
    fs.writeFileSync(path.join(dir, 'edition.json'), JSON.stringify(edition));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

const minimal = {
    appName: 'Example Chat',
    appId: 'org.example.chat',
    executableName: 'example-chat',
    icon: 'icon.png',
    chat: { primaryServer: 'irc.example.org' },
};

test('the bundled StarChat edition is valid and presets no network', () => {
    const { edition, files } = loadEdition(path.join(desktopDir, 'edition'));
    assert.equal(edition.appName, 'StarChat');
    assert.ok(fs.existsSync(files.icon));
    assert.equal(edition.chat.primaryServer, undefined, 'like other desktop IRC clients: the user picks the network');
});

test('without a primary server there is no network name and no home server', () => {
    const { chat, ...rest } = minimal;
    const { edition } = loadEdition(editionFolder({ ...rest, chat: {} }));
    const app = runtimeEdition(edition, '1.0.0');
    assert.equal(app.chat.primaryServer, '');
    assert.equal(app.chat.networkName, '');
});

test('a minimal edition is valid and gets defaults at runtime', () => {
    const { edition } = loadEdition(editionFolder(minimal));
    const app = runtimeEdition(edition, '1.2.3');
    assert.equal(app.dataDir, 'example-chat');
    assert.equal(app.version, '1.2.3');
    assert.equal(app.splashImage, 'icon.png');
    assert.equal(app.chat.serverList, 'default');
    assert.equal(app.chat.networkName, 'irc.example.org', 'the domain names the network by default');
    assert.equal(app.updates, null);
    assert.equal(app.chatBundles, null);
});

test('schema errors name the field', () => {
    const dir = editionFolder({ ...minimal, appId: 'no id', extra: true });
    assert.throws(() => loadEdition(dir), /appId[\s\S]*additional properties|additional properties[\s\S]*appId/);
});

test('files of an edition must exist and stay inside its folder', () => {
    assert.throws(() => loadEdition(editionFolder({ ...minimal, icon: 'missing.png' })), /icon: missing.png does not exist/);
    assert.throws(() => loadEdition(editionFolder({ ...minimal, icon: '../outside.png' })), /outside the edition folder/);
});

test('the icon must be a square PNG of at least 512 pixels', () => {
    assert.throws(() => loadEdition(editionFolder(minimal, { 'icon.png': fakePng(500, 500) })), /at least 512x512 pixels \(is 500x500\)/);
    assert.throws(() => loadEdition(editionFolder(minimal, { 'icon.png': fakePng(1024, 512) })), /square/);
    assert.throws(() => loadEdition(editionFolder(minimal, { 'icon.png': 'not a png' })), /square PNG/);
});

test('an own data folder keeps the profiles of an older app', () => {
    const { edition } = loadEdition(editionFolder({ ...minimal, dataDir: 'example-chat-old' }));
    assert.equal(runtimeEdition(edition, '1.0.0').dataDir, 'example-chat-old');
});

test('a former data folder is used until the new one exists', () => {
    const edition = { dataDir: 'example-chat', formerDataDirs: ['Example Chat', 'example-old'] };
    assert.equal(chooseDataDir(edition, name => name === 'example-old'), 'example-old');
    assert.equal(chooseDataDir(edition, name => ['Example Chat', 'example-old'].includes(name)), 'Example Chat');
    assert.equal(chooseDataDir(edition, () => true), 'example-chat');
    assert.equal(chooseDataDir(edition, () => false), 'example-chat', 'a new install gets the new folder');
    assert.equal(chooseDataDir({ dataDir: 'x' }, () => false), 'x');
});

test('the signing key of chat updates stays out of the runtime settings', () => {
    const { edition } = loadEdition(editionFolder(
        { ...minimal, chatBundles: { manifestUrl: 'https://example.org/chat/manifest.json', publicKey: 'key.pem' } },
        { 'icon.png': fakePng(1024, 1024), 'key.pem': 'pem' },
    ));
    assert.deepEqual(runtimeEdition(edition, '1.0.0').chatBundles, { manifestUrl: 'https://example.org/chat/manifest.json' });
});

test('electron-builder gets names, ids, icons and the update feed of the edition', () => {
    const edition = { ...minimal, publisher: 'Example e.V.', updates: { provider: 'generic', url: 'https://example.org/updates' } };
    const config = builderConfig(pkg.build, edition, '2.0.0');
    assert.equal(config.appId, 'org.example.chat');
    assert.equal(config.productName, 'Example Chat');
    assert.equal(config.extraMetadata.version, '2.0.0');
    assert.equal(config.extraMetadata.name, 'example-chat');
    assert.equal(config.nsis.artifactName, 'example-chat-setup-${version}.${ext}');
    assert.equal(config.linux.executableName, 'example-chat');
    assert.equal(config.executableName, undefined, 'Windows and macOS keep the program name of appName');
    assert.equal(config.win.icon, 'generated/icon.png');
    assert.deepEqual(config.publish, [{ provider: 'generic', url: 'https://example.org/updates' }]);
    assert.equal(config.copyright, 'Copyright © Example e.V.');
    // the static part from package.json stays
    assert.deepEqual(config.files, pkg.build.files);
    assert.equal(config.nsis.oneClick, false);
    assert.equal(pkg.build.appId, undefined, 'package.json itself names no edition');
});

test('without updates the app gets no update feed', () => {
    assert.equal(builderConfig(pkg.build, minimal, '1.0.0').publish, null);
});

test('every file the app loads is packed', () => {
    const main = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    // package.json is always packed by electron-builder
    const required = [...main.matchAll(/require\('\.\/([^']+?)(?:\.js)?'\)/g)]
        .filter(match => !match[1].endsWith('.json'))
        .map(match => `${match[1]}.js`);
    assert.ok(required.includes('edition.js'));
    for (const file of required) assert.ok(pkg.build.files.includes(file), `${file} is missing in build.files`);
    for (const file of ['generated/edition.json', 'generated/icon.png', 'generated/servers.json', 'generated/chat/**']) {
        assert.ok(pkg.build.files.includes(file), `${file} is missing in build.files`);
    }
});

test('chat updates live in their own folder, never in the one of an older app', () => {
    const main = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
    assert.match(main, /CHAT_BUNDLES_DIR = path\.join\(app\.getPath\('userData'\), 'chat-updates'\)/);
});

test('shell texts: edition overrides, then :app and :network', () => {
    const edition = { appName: 'Example Chat', chat: { primaryServer: 'irc.example.org', networkName: 'Example Net' }, texts: { de: { quit_title: ':app beenden?' } } };
    const texts = shellTexts({ app_title: ':app', quit_title: 'Close :app?', home: 'Account on :network', other: ':apply' }, edition, 'de');
    assert.equal(texts.app_title, 'Example Chat');
    assert.equal(texts.quit_title, 'Example Chat beenden?');
    assert.equal(texts.home, 'Account on Example Net');
    assert.equal(texts.other, ':apply', 'only whole placeholders are replaced');
});

test('the shell locales name no network', () => {
    for (const language of ['de', 'en']) {
        const text = fs.readFileSync(path.join(desktopDir, 'locales', `${language}.json`), 'utf8');
        assert.doesNotMatch(text, /ST-City/);
    }
});

test('server list URL of the edition', () => {
    assert.equal(serverListUrl({ chat: {} }), PUBLIC_SERVER_LIST_URL);
    assert.equal(serverListUrl({ chat: { serverList: 'https://example.org/servers.json' } }), 'https://example.org/servers.json');
    assert.equal(serverListUrl({ chat: { serverList: false } }), null);
});

test('server list entries become directory entries, TCP first', () => {
    const entries = toDirectoryEntries({
        servers: [
            { id: 'libera', name: 'Libera.Chat', domain: 'libera.chat', description: { en: 'FOSS', de: 'Freie Software' }, irc: { host: 'irc.libera.chat', port: 6697, tls: true }, websocket: 'wss://web.libera.chat/' },
            { id: 'web', name: 'Web only', domain: 'example.org', websocket: 'wss://irc.example.org/webirc' },
            { id: 'broken', name: 'Nothing' },
            null,
        ],
    }, 'de');
    assert.deepEqual(entries, [
        { id: 'libera', name: 'Libera.Chat', domain: 'libera.chat', description: 'Freie Software', host: 'irc.libera.chat', port: 6697, ssl: true, websocket_url: '' },
        { id: 'web', name: 'Web only', domain: 'example.org', description: '', host: '', port: 6697, ssl: true, websocket_url: 'wss://irc.example.org/webirc' },
    ]);
    assert.deepEqual(toDirectoryEntries('garbage'), []);
});

test('the build bundles the public list of the checkout', async () => {
    const list = await serverListForBuild({ chat: {} });
    const repo = JSON.parse(fs.readFileSync(new URL('../../servers/servers.json', import.meta.url), 'utf8'));
    assert.deepEqual(list, repo);
    assert.equal(await serverListForBuild({ chat: { serverList: false } }), null);
});

test('an own list of the edition is downloaded at build time and must be a server list', async () => {
    const own = { schemaVersion: 1, servers: [{ id: 'x', name: 'X', domain: 'x.example', languages: ['en'], websocket: 'wss://x.example' }] };
    const ok = async () => ({ ok: true, json: async () => own });
    assert.deepEqual(await serverListForBuild({ chat: { serverList: 'https://x.example/servers.json' } }, { fetchImpl: ok }), own);

    const missing = async () => ({ ok: false, status: 404 });
    await assert.rejects(serverListForBuild({ chat: { serverList: 'https://x.example/servers.json' } }, { fetchImpl: missing }), /HTTP 404/);
    const garbage = async () => ({ ok: true, json: async () => ({ hello: 1 }) });
    await assert.rejects(serverListForBuild({ chat: { serverList: 'https://x.example/servers.json' } }, { fetchImpl: garbage }), /not a server list/);
    await assert.rejects(serverListForBuild({ chat: {} }, { readRepoList: () => '{"schemaVersion":1,"servers":[]}' }), /not a server list/);
});

test('the downloaded directory wins, the bundled list fills in without one', () => {
    const bundled = { schemaVersion: 1, servers: [{ id: 'b', name: 'Bundled', domain: 'b.example', irc: { host: 'irc.b.example', port: 6697, tls: true } }] };
    assert.deepEqual(directoryEntries([], bundled).map(entry => entry.name), ['Bundled']);
    assert.deepEqual(directoryEntries(null, bundled).map(entry => entry.name), ['Bundled']);
    assert.deepEqual(directoryEntries([{ name: 'Downloaded' }], bundled).map(entry => entry.name), ['Downloaded']);
    assert.deepEqual(directoryEntries([], null), []);
    assert.equal(directoryDomainFor(directoryEntries([], bundled), { connectionType: 'socket', host: 'irc.b.example' }), 'b.example', 'old profiles find their domain offline too');
});

test('older profiles find their network domain in the directory', () => {
    const entries = [
        { domain: 'st-city.net', host: 'irc.st-city.net', websocket_url: '' },
        { domain: 'example.org', host: '', websocket_url: 'wss://irc.example.org/webirc' },
    ];
    assert.equal(directoryDomainFor(entries, { connectionType: 'socket', host: 'IRC.st-city.net' }), 'st-city.net');
    assert.equal(directoryDomainFor(entries, { connectionType: 'websocket', websocketUrl: 'wss://irc.example.org/webirc' }), 'example.org');
    assert.equal(directoryDomainFor(entries, { connectionType: 'socket', host: 'irc.unknown.net' }), '');
    assert.equal(directoryDomainFor(null, { connectionType: 'socket', host: 'irc.st-city.net' }), '');
});

function fakeFetch(responses) {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return { ok: next !== null, json: async () => next };
    };
    return { calls, fetchImpl };
}

test('discovery: API and features of the primary server, cached', async () => {
    let now = 0;
    const { calls, fetchImpl } = fakeFetch([
        { apiBaseUrl: 'https://example.org/api/', features: ['spotify'] },
        { apiBaseUrl: 'https://example.org/api2', features: [] },
    ]);
    const discovery = createDiscoveryCache({ domain: 'example.org', fetchImpl, now: () => now });
    assert.equal(await discovery.apiBaseUrl(), 'https://example.org/api');
    assert.equal(await discovery.hasFeature('spotify'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://example.org/.well-known/starchat.json');

    now = 2 * 60 * 60 * 1000;
    assert.equal(await discovery.hasFeature('spotify'), false);
    assert.equal(calls.length, 2);
});

test('discovery: no file or an http API means no API', async () => {
    const missing = createDiscoveryCache({ domain: 'plain.example', fetchImpl: fakeFetch([null]).fetchImpl });
    assert.equal(await missing.apiBaseUrl(), null);
    assert.equal(await missing.hasFeature('spotify'), false);

    const insecure = createDiscoveryCache({ domain: 'x.example', fetchImpl: fakeFetch([{ apiBaseUrl: 'http://x.example/api', features: ['spotify'] }]).fetchImpl });
    assert.equal(await insecure.hasFeature('spotify'), false);
});

test('discovery: a failed refresh keeps the last good answer', async () => {
    let now = 0;
    const { fetchImpl } = fakeFetch([{ apiBaseUrl: 'https://example.org/api' }, new Error('offline')]);
    const discovery = createDiscoveryCache({ domain: 'example.org', fetchImpl, now: () => now });
    assert.equal(await discovery.apiBaseUrl(), 'https://example.org/api');
    now = 2 * 60 * 60 * 1000;
    assert.equal(await discovery.apiBaseUrl(), 'https://example.org/api');
});
