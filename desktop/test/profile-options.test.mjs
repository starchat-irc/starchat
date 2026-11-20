/**
 * Chat page of the desktop app: connection profile of the shell → mountChat() options.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountOptionsFor, externalServerEntry, SHELL_MESSAGE_TYPES } from '../chat/profile-options.mjs';

const edition = {
    appName: 'Example Chat',
    chat: { primaryServer: 'irc.example.org', defaultChannel: '#lobby', theme: 'dark', ctcpVersion: 'Example 1.0' },
    texts: { en: { login_title: 'Welcome' }, de: { login_title: 'Willkommen' } },
};

test('a home profile connects to the primary server of the edition, without server choice', () => {
    const { options, error } = mountOptionsFor({ isExternalServer: false, locale: 'de-DE' }, edition);
    assert.equal(error, null);
    assert.equal(options.primaryServer, 'irc.example.org');
    assert.equal(options.serverList, false);
    assert.equal(options.defaultChannel, '#lobby');
    assert.equal(options.shell, 'desktop');
    assert.equal(options.appName, 'Example Chat');
    assert.equal(options.theme, 'dark');
    assert.equal(options.ctcpVersion, 'Example 1.0');
    assert.equal(options.locale, 'de-DE');
    assert.deepEqual(options.overrides, { login_title: 'Willkommen' });
    assert.equal(options.nickname, undefined, 'without credentials the login dialog shows');
});

test('settings and drafts are stored per connection profile, as in the desktop chat before', () => {
    assert.equal(mountOptionsFor({ isExternalServer: false, profileHash: 'abc-123' }, edition).options.storageScope, 'abc-123');
    assert.equal(mountOptionsFor({ isExternalServer: false }, edition).options.storageScope, undefined);
});

test('a home profile needs a primary server in the edition', () => {
    assert.equal(mountOptionsFor({ isExternalServer: false }, { appName: 'StarChat', chat: {} }).error, 'no-primary-server');
});

test('a home profile with a stored token logs in with it', async () => {
    const { options } = mountOptionsFor({ isExternalServer: false, password: ' tok ', nickname: 'Obi_Wan' }, edition);
    assert.deepEqual(await options.bearer(), { token: 'tok', nickname: 'Obi_Wan' });
});

test('SASL PLAIN credentials go to the chat as nick and password', () => {
    const { options } = mountOptionsFor({ isExternalServer: false, authMethod: 'sasl_plain', nickname: 'Obi_Wan', saslPassword: 'secret' }, edition);
    assert.equal(options.nickname, 'Obi_Wan');
    assert.equal(options.password, 'secret');
    assert.equal(options.bearer, undefined);
});

test('an external WebSocket profile uses its own server and channel', () => {
    const { options, error } = mountOptionsFor({
        isExternalServer: true,
        connectionType: 'websocket',
        websocketUrl: 'wss://web.libera.chat/',
        nickname: 'guest42',
        defaultChannel: '#libera',
        profileHash: 'abc',
    }, edition);
    assert.equal(error, null);
    assert.deepEqual(options.primaryServer, { id: 'profile-abc', name: 'web.libera.chat', domain: 'web.libera.chat', languages: [], websocket: 'wss://web.libera.chat/', allowInsecureWebsocket: false });
    assert.equal(options.defaultChannel, '#libera');
    assert.equal(options.nickname, 'guest42');
    assert.equal(options.bearer, undefined);
});

test('a directory profile looks up discovery at its network domain, never at a foreign one', () => {
    const tcp = { isExternalServer: true, connectionType: 'socket', socketHost: 'irc.st-city.net', socketPort: 6697 };
    assert.equal(mountOptionsFor({ ...tcp, networkDomain: 'st-city.net' }, edition).options.primaryServer.domain, 'st-city.net');
    assert.equal(mountOptionsFor({ ...tcp, networkDomain: 'evil.example' }, edition).options.primaryServer.domain, 'irc.st-city.net');
    assert.equal(mountOptionsFor({ ...tcp, networkDomain: 'net' }, edition).options.primaryServer.domain, 'irc.st-city.net');
    assert.equal(mountOptionsFor(tcp, edition).options.primaryServer.domain, 'irc.st-city.net');
});

test('a token stored for an external profile logs in on its server', async () => {
    const { options } = mountOptionsFor({ isExternalServer: true, connectionType: 'socket', socketHost: 'irc.st-city.net', socketPort: 6697, password: 'tok', nickname: 'Obi' }, edition);
    assert.deepEqual(await options.bearer(), { token: 'tok', nickname: 'Obi' });
});

test('a WebSocket without TLS is allowed for a server the user set up', () => {
    const entry = externalServerEntry({ websocketUrl: 'ws://irc.lan.example:8097/', profileHash: 'x' });
    assert.equal(entry.websocket, 'ws://irc.lan.example:8097/');
    assert.equal(entry.allowInsecureWebsocket, true);
    assert.equal(externalServerEntry({ websocketUrl: 'wss://irc.example.org/' }).allowInsecureWebsocket, false);
});

test('a TCP profile gets an irc entry, an IP address no discovery domain', () => {
    const { options, error } = mountOptionsFor({
        isExternalServer: true,
        connectionType: 'socket',
        socketHost: 'irc.libera.chat',
        socketPort: 6697,
        socketSsl: true,
        profileHash: 'ABC-1',
    }, edition);
    assert.equal(error, null);
    assert.deepEqual(options.primaryServer, { id: 'profile-abc-1', name: 'irc.libera.chat', domain: 'irc.libera.chat', languages: [], irc: { host: 'irc.libera.chat', port: 6697, tls: true } });
    const local = externalServerEntry({ connectionType: 'socket', socketHost: '192.168.0.5', socketPort: 6667, socketSsl: false });
    assert.equal(local.domain, 'ip-address.invalid');
    assert.equal(local.irc.tls, false);
});

test('broken servers report an error', () => {
    assert.equal(mountOptionsFor({ isExternalServer: true, connectionType: 'socket', socketHost: 'irc.libera.chat' }, edition).error, 'invalid-server');
    assert.equal(mountOptionsFor({ isExternalServer: true, connectionType: 'websocket', websocketUrl: 'https://x' }, edition).error, 'invalid-server');
    assert.equal(externalServerEntry({ websocketUrl: 'http://insecure.example/' }), null);
    assert.equal(externalServerEntry({ websocketUrl: 'nonsense' }), null);
});

test('a SASL account that differs from the nick is passed on', () => {
    const { options } = mountOptionsFor({ isExternalServer: true, connectionType: 'socket', socketHost: 'irc.libera.chat', socketPort: 6697, authMethod: 'sasl_plain', nickname: 'obi', saslUsername: 'ObiWan', saslPassword: 'pw' }, edition);
    assert.equal(options.nickname, 'obi');
    assert.equal(options.saslAccount, 'ObiWan');
});

test('the chat page accepts only known shell messages', () => {
    assert.ok(SHELL_MESSAGE_TYPES.includes('settings-state'));
    assert.ok(!SHELL_MESSAGE_TYPES.includes('irc-raw'), 'raw IRC lines from the shell are not passed on');
});
