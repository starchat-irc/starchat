import { test } from 'node:test';
import assert from 'node:assert/strict';
import ConnectionForm from '../html/shared/connection.js';

const {
    emptyExternalServer,
    fromCuratedServer,
    validateExternalServer,
    validateHomeProfile,
    normalizeExternalServer,
    buildExternalProfile,
    buildHomeProfile,
    describeServer,
    networkName,
    tabLabel,
    setHomeNetworkName,
} = ConnectionForm;

setHomeNetworkName('ST-City');

test('the network domain must be the host or a parent of it', () => {
    const { networkDomain, normalizeExternalServer, fromCuratedServer } = ConnectionForm;
    assert.equal(networkDomain({ connectionType: 'socket', host: 'irc.st-city.net', domain: 'st-city.net' }), 'st-city.net');
    assert.equal(networkDomain({ connectionType: 'websocket', websocketUrl: 'wss://skynet.st-city.net', domain: 'ST-City.net' }), 'st-city.net');
    assert.equal(networkDomain({ connectionType: 'socket', host: 'irc.st-city.net', domain: 'evil.example' }), '');
    assert.equal(networkDomain({ connectionType: 'socket', host: 'irc.evil-st-city.net', domain: 'st-city.net' }), '');
    assert.equal(networkDomain({ connectionType: 'socket', host: 'irc.st-city.net', domain: 'net' }), '');
    assert.equal(normalizeExternalServer({ host: 'irc.libera.chat', domain: 'st-city.net' }).domain, '', 'stored only when it fits');
    assert.equal(fromCuratedServer({ host: 'irc.st-city.net', domain: 'st-city.net' }).domain, 'st-city.net');
});

const socket = (overrides = {}) => ({ ...emptyExternalServer(), host: 'irc.libera.chat', port: 6697, ...overrides });

test('a complete socket server is valid', () => {
    assert.deepEqual(validateExternalServer(socket({ nickname: 'Klaas', defaultChannel: '#st-city' })), {});
    assert.deepEqual(validateExternalServer(socket({ host: '127.0.0.1' })), {});
    assert.deepEqual(validateExternalServer(socket({ host: '[::1]' })), {});
});

test('socket servers need a plain host and a port in range', () => {
    assert.equal(validateExternalServer(socket({ host: '' })).host, 'connection_error_host_required');
    assert.equal(validateExternalServer(socket({ host: 'ircs://irc.libera.chat' })).host, 'connection_error_host_invalid');
    assert.equal(validateExternalServer(socket({ host: 'irc libera' })).host, 'connection_error_host_invalid');
    assert.equal(validateExternalServer(socket({ port: 0 })).port, 'connection_error_port');
    assert.equal(validateExternalServer(socket({ port: 70000 })).port, 'connection_error_port');
    assert.equal(validateExternalServer(socket({ port: '66.5' })).port, 'connection_error_port');
});

test('websocket servers need a ws(s) URL, host and port do not matter', () => {
    const ws = { ...emptyExternalServer(), connectionType: 'websocket', websocketUrl: 'wss://web.libera.chat/webirc/websocket/' };
    assert.deepEqual(validateExternalServer(ws), {});
    assert.equal(validateExternalServer({ ...ws, websocketUrl: 'https://web.libera.chat' }).websocketUrl, 'connection_error_websocket_url');
    assert.equal(validateExternalServer({ ...ws, websocketUrl: 'kein link' }).websocketUrl, 'connection_error_websocket_url');
});

test('nickname, channel and SASL are checked', () => {
    assert.equal(validateExternalServer(socket({ nickname: '1abc' })).nickname, 'connection_error_nickname');
    assert.equal(validateExternalServer(socket({ nickname: 'mit leer' })).nickname, 'connection_error_nickname');
    assert.equal(validateExternalServer(socket(), { requireNickname: true }).nickname, 'connection_error_nickname_required');
    assert.equal(validateExternalServer(socket({ defaultChannel: 'lobby' })).defaultChannel, 'connection_error_channel');

    assert.equal(validateExternalServer(socket({ saslUsername: 'klaas' })).saslPassword, 'connection_error_sasl_password');
    assert.deepEqual(validateExternalServer(socket({ saslUsername: 'klaas' }), { saslPassword: 'geheim' }), {});
    assert.deepEqual(validateExternalServer(socket({ saslUsername: 'klaas' }), { hasSaslPassword: true }), {});
});

test('home profiles only validate nick and SASL', () => {
    assert.deepEqual(validateHomeProfile({ nickname: 'Obi_Wan' }), {});
    assert.equal(validateHomeProfile({ saslUsername: 'obi' }).saslPassword, 'connection_error_sasl_password');
});

test('curated servers are taken over with socket when they name a host', () => {
    assert.deepEqual(
        fromCuratedServer({ host: 'irc.libera.chat', port: '6697', ssl: true, websocket_url: 'wss://x', default_channel: '#libera' }),
        { ...emptyExternalServer(), connectionType: 'socket', host: 'irc.libera.chat', port: 6697, websocketUrl: 'wss://x', defaultChannel: '#libera' },
    );
    assert.equal(fromCuratedServer({ websocket_url: 'wss://x' }).connectionType, 'websocket');
});

test('stored servers are trimmed, never keep a plain password and derive the auth method', () => {
    const stored = normalizeExternalServer(socket({ host: ' irc.libera.chat ', saslUsername: ' klaas ', saslPassword: 'geheim' }), { saslPassword: 'geheim' });
    assert.equal(stored.host, 'irc.libera.chat');
    assert.equal(stored.saslUsername, 'klaas');
    assert.equal(stored.saslPassword, '');
    assert.equal(stored.authMethod, 'sasl_plain');
    assert.equal(normalizeExternalServer(socket()).authMethod, 'none');
});

test('built profiles get a fresh id and a sensible name', () => {
    const a = buildExternalProfile({ externalServer: socket({ nickname: 'Klaas' }) });
    const b = buildExternalProfile({ name: 'Libera', externalServer: socket() });
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.name, 'Klaas');
    assert.equal(b.name, 'Libera');
    assert.equal(b.serverType, 'external');
    assert.equal(buildHomeProfile().serverType, 'home');
});

test('servers are described for lists', () => {
    assert.equal(describeServer(socket()), 'irc.libera.chat:6697 (TLS)');
    assert.equal(describeServer(socket({ ssl: false, port: 6667 })), 'irc.libera.chat:6667');
    assert.equal(describeServer({ connectionType: 'websocket', websocketUrl: 'wss://x' }), 'wss://x');
});

const home = { hash: 'h1', serverType: 'home', name: 'Obi_Wan' };
const libera = { hash: 'l1', serverType: 'external', name: 'Libera', externalServer: { ...emptyExternalServer(), host: 'irc.libera.chat', nickname: 'Obi_Wan' } };

test('a single network shows only the nick', () => {
    assert.equal(tabLabel(home, 0, [home]), 'Obi_Wan');
    assert.equal(tabLabel(libera, 0, [libera]), 'Obi_Wan');
    const secondHome = { ...home, hash: 'h2', name: 'Anakin' };
    assert.equal(tabLabel(secondHome, 1, [home, secondHome]), 'Anakin', 'two accounts on the home server are still one network');
});

test('several networks add the network name to every tab', () => {
    const profiles = [home, libera];
    assert.equal(tabLabel(home, 0, profiles), 'Obi_Wan · ST-City');
    assert.equal(tabLabel(libera, 1, profiles), 'Obi_Wan · Libera');
});

test('the network name falls back to the host when the profile has no own name', () => {
    const unnamed = { ...libera, name: 'Obi_Wan' };
    assert.equal(networkName(unnamed), 'libera.chat');
    const ws = { hash: 'w1', serverType: 'external', name: '', externalServer: { ...emptyExternalServer(), connectionType: 'websocket', websocketUrl: 'wss://web.oftc.net/ws', nickname: 'x' } };
    assert.equal(networkName(ws), 'web.oftc.net');
    assert.equal(tabLabel(ws, 2, [home, ws]), 'x · web.oftc.net');
});

test('a tab without a nick yet still gets a label', () => {
    const fresh = { hash: 'n1', serverType: 'home', name: '' };
    assert.equal(tabLabel(fresh, 0, [fresh]), 'ST-City');
    assert.equal(tabLabel({ ...libera, externalServer: { ...libera.externalServer, nickname: '' } }, 1, [home, libera]), 'Libera');
});
