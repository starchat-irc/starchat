import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatConfig, createProfileStore } from '../shell/profiles.mjs';
import { mountOptionsFor } from '../../desktop/chat/profile-options.mjs';

const SERVER_LIST = {
    schemaVersion: 1,
    servers: [
        { id: 'libera', name: 'Libera.Chat', domain: 'libera.chat', description: { en: 'FOSS' }, languages: ['en'], irc: { host: 'irc.libera.chat', port: 6697, tls: true } },
        { id: 'web', name: 'Web Net', domain: 'web.example.org', description: { en: 'WS only' }, languages: ['en'], websocket: 'wss://web.example.org/irc' },
    ],
};

function memoryStore(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        get: async key => (data.has(key) ? data.get(key) : null),
        set: async (key, value) => {
            if (value === null) data.delete(key);
            else data.set(key, value);
        },
    };
}

/** Reversible stand-in for the Keystore encryption. */
const secrets = {
    encrypt: async value => `enc:${Buffer.from(value).toString('base64')}`,
    decrypt: async value => (value.startsWith('enc:') ? Buffer.from(value.slice(4), 'base64').toString() : null),
};

function profileStore({ primaryServer = '', store = memoryStore(), fetchImpl, testConnection } = {}) {
    return createProfileStore({
        store,
        secrets,
        edition: { appName: 'StarChat', chat: { primaryServer, networkName: primaryServer ? 'Home Net' : '', serverList: 'default' } },
        bundledServers: SERVER_LIST,
        fetchImpl,
        testConnection,
    });
}

test('without a primary server the app starts without connections', async () => {
    const profiles = profileStore();
    await profiles.load();
    assert.deepEqual(profiles.profiles, []);
    assert.equal(profiles.active, '');
    assert.equal(profiles.directory().length, 2, 'the bundled list until the first download');
});

test('an edition with a primary server starts with a connection bound to it', async () => {
    const store = memoryStore();
    const profiles = profileStore({ primaryServer: 'home.example.org', store });
    await profiles.load();
    assert.equal(profiles.profiles.length, 1);
    assert.equal(profiles.profiles[0].server, 'home.example.org');
    assert.equal(profiles.label(profiles.active), 'Home Net');
    assert.equal(JSON.parse(store.data.get('profiles')).length, 1);
});

test('a network from the directory becomes a TCP connection with the chosen nick', async () => {
    const profiles = profileStore();
    await profiles.load();
    const result = await profiles.addFromDirectory(profiles.directory()[0], 'kenobi');
    assert.equal(result.ok, true);
    const config = await profiles.configFor(result.profile.hash, 'de-DE');
    assert.equal(config.socketHost, 'irc.libera.chat');
    assert.equal(config.socketPort, 6697);
    assert.equal(config.socketSsl, true);
    assert.equal(config.nickname, 'kenobi');
    assert.equal(config.networkDomain, 'libera.chat');
    assert.equal(profiles.label(result.profile.hash), 'Libera.Chat');

    // The chat page turns it into a server entry for mountChat()
    const { options, error } = mountOptionsFor(config, { appName: 'StarChat', chat: {} });
    assert.equal(error, null);
    assert.deepEqual(options.primaryServer.irc, { host: 'irc.libera.chat', port: 6697, tls: true });
    assert.equal(options.nickname, 'kenobi');
});

test('invalid nicks and servers from the start screen are refused', async () => {
    const profiles = profileStore();
    await profiles.load();
    const badNick = await profiles.addFromDirectory(profiles.directory()[0], 'two words');
    assert.equal(badNick.ok, false);
    assert.equal(badNick.errors.nickname, 'connection_error_nickname');
    const badHost = await profiles.addCustom({ connectionType: 'socket', host: 'ircs://x.org', port: 6697, ssl: true, nickname: 'kenobi' });
    assert.equal(badHost.errors.host, 'connection_error_host_invalid');
    assert.deepEqual(profiles.profiles, []);
});

test('passwords and tokens are stored encrypted and only given to their connection', async () => {
    const store = memoryStore();
    const profiles = profileStore({ store });
    await profiles.load();
    const saved = await profiles.request('save', {
        serverType: 'external',
        name: 'Libera',
        externalServer: { connectionType: 'socket', host: 'irc.libera.chat', port: 6697, ssl: true, nickname: 'kenobi', saslUsername: 'kenobi' },
        saslPassword: 'hunter2',
    }, '');
    assert.equal(saved.ok, true);
    assert.equal(saved.profile.hasSaslPassword, true);
    assert.ok(!JSON.stringify(saved).includes('hunter2'), 'the chat page never sees the password');
    assert.ok(!store.data.get('profiles').includes('hunter2'), 'never stored in plain text');

    const hash = saved.profile.hash;
    await profiles.setToken(hash, ' token-1 ');
    const config = await profiles.configFor(hash);
    assert.equal(config.saslPassword, 'hunter2');
    assert.equal(config.authMethod, 'sasl_plain');
    assert.equal(config.password, 'token-1');

    // Another server: the stored password and token were meant for the old one
    const refused = await profiles.request('save', { hash, externalServer: { host: 'irc.oftc.net' } }, hash);
    assert.equal(refused.errors.saslPassword, 'connection_error_sasl_password', 'the SASL account needs its password again');
    assert.equal((await profiles.request('save', { hash, externalServer: { host: 'irc.oftc.net', saslUsername: '' } }, hash)).ok, true);
    const moved = await profiles.configFor(hash);
    assert.equal(moved.saslPassword, '');
    assert.equal(moved.password, '');
});

test('connections page: list, delete and open', async () => {
    const profiles = profileStore();
    await profiles.load();
    const first = (await profiles.addFromDirectory(profiles.directory()[0], 'kenobi')).profile.hash;
    const second = (await profiles.addFromDirectory(profiles.directory()[1], 'kenobi')).profile.hash;
    await profiles.setActive(second);

    const listed = await profiles.request('list', {}, second);
    assert.deepEqual(listed.profiles.map(profile => profile.hash), [first, second]);
    assert.equal(listed.current, second);
    assert.ok(!('encryptedToken' in listed.profiles[0]));

    assert.deepEqual(await profiles.request('open', { hash: first }, second), { ok: true, open: first });
    assert.equal((await profiles.request('open', { hash: 'nope' }, second)).ok, false);

    const deleted = await profiles.request('delete', { hash: second }, second);
    assert.equal(deleted.deleted, second);
    assert.equal(profiles.active, first, 'the remaining connection comes on screen');
    assert.equal((await profiles.request('delete', { hash: first }, first)).reason, 'not_allowed', 'one connection stays');
});

test('connection tests are rate limited', async () => {
    let calls = 0;
    const profiles = profileStore({ testConnection: async () => { calls++; return { ok: true, ms: 12 }; } });
    await profiles.load();
    assert.deepEqual(await profiles.request('test', { host: 'irc.libera.chat', port: 6697 }, ''), { ok: true, ms: 12 });
    assert.equal((await profiles.request('test', { host: 'irc.libera.chat', port: 6697 }, '')).reason, 'rate_limited');
    assert.equal(calls, 1);
});

test('the directory is refreshed from the edition list, a broken answer keeps the old one', async () => {
    const store = memoryStore();
    let answer = { ok: true, status: 200, json: async () => ({ schemaVersion: 1, servers: [SERVER_LIST.servers[0]] }) };
    const fetchImpl = async () => answer;
    const profiles = profileStore({ store, fetchImpl });
    await profiles.load();

    const synced = await profiles.request('directory-sync', {}, '');
    assert.equal(synced.ok, true);
    assert.equal(profiles.directory().length, 1);
    assert.ok(JSON.parse(store.data.get('directory')).syncedAt);

    answer = { ok: true, status: 200, json: async () => ({ servers: [] }) };
    const failed = await profiles.syncDirectory();
    assert.equal(failed.ok, false);
    assert.equal(profiles.directory().length, 1);
});

test('nick changes in the chat are kept for the connection list', async () => {
    const profiles = profileStore();
    await profiles.load();
    const hash = (await profiles.addFromDirectory(profiles.directory()[0], 'kenobi')).profile.hash;
    await profiles.setNickname(hash, 'ben');
    assert.equal((await profiles.configFor(hash)).nickname, 'ben');
    await profiles.setNickname(hash, 'not a nick');
    assert.equal((await profiles.configFor(hash)).nickname, 'ben');
});

test('home connections use the saved login or SASL', () => {
    const bearer = chatConfig({ hash: 'h', serverType: 'home', nickname: 'kenobi' }, { token: 't' });
    assert.equal(bearer.authMethod, 'ircv3bearer');
    assert.equal(bearer.password, 't');
    const sasl = chatConfig({ hash: 'h', serverType: 'home', saslUsername: 'ben' }, { saslPassword: 'pw' });
    assert.equal(sasl.authMethod, 'sasl_plain');
    assert.equal(sasl.saslUsername, 'ben');
});

test('a network picked without nick opens the login dialog, a login there stays', async () => {
    const store = memoryStore();
    const profiles = profileStore({ store });
    await profiles.load();
    const hash = (await profiles.addFromDirectory(profiles.directory()[0])).profile.hash;
    const first = mountOptionsFor(await profiles.configFor(hash), { appName: 'StarChat', chat: {} }).options;
    assert.equal(first.nickname, undefined, 'no nick: the chat shows its login dialog');
    assert.equal(first.bearer, undefined);

    // SASL login in the dialog, then the next start logs in right away
    await profiles.setNickname(hash, 'kenobi');
    await profiles.setSaslLogin(hash, 'kenobi', 'hunter2');
    assert.ok(!store.data.get('profiles').includes('hunter2'), 'never stored in plain text');
    const next = mountOptionsFor(await profiles.configFor(hash), { appName: 'StarChat', chat: {} }).options;
    assert.equal(next.nickname, 'kenobi');
    assert.equal(next.password, 'hunter2');

    // The same login again changes nothing
    const stored = store.data.get('profiles');
    await profiles.setSaslLogin(hash, 'kenobi', 'hunter2');
    assert.equal(store.data.get('profiles'), stored);

    await profiles.setSaslLogin(hash, 'two words', 'x');
    assert.equal(store.data.get('profiles'), stored, 'no account name, no change');

    // Logout: login and nick go, the dialog comes back
    await profiles.setToken(hash, 'tok');
    await profiles.clearLogin(hash);
    const after = await profiles.configFor(hash);
    assert.equal(after.password, '');
    assert.equal(after.saslPassword, '');
    const options = mountOptionsFor(after, { appName: 'StarChat', chat: {} }).options;
    assert.equal(options.nickname, undefined);
    assert.equal(options.bearer, undefined);
});

test('the primary server of an edition keeps its login out of setSaslLogin', async () => {
    const profiles = profileStore({ primaryServer: 'home.example.org' });
    await profiles.load();
    const before = JSON.stringify(profiles.profiles);
    await profiles.setSaslLogin(profiles.active, 'kenobi', 'pw');
    assert.equal(JSON.stringify(profiles.profiles), before);
});
