/**
 * Connections API of the desktop app (electron/connections.js): what the chat's settings
 * page may see and change. The page is untrusted: no secrets out, only validated fields in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Connections from '../connections.js';

const { publicProfile, applyConnectionUpdate, canDeleteConnection, createTestLimiter, usableProfiles, mergeShellProfiles, mayUseCredentials, serverAddress } = Connections;

function storedProfiles() {
    return [
        {
            hash: 'home-1',
            name: 'Obi_Wan',
            serverType: 'home',
            server: 'st-city.net',
            nickname: 'Obi_Wan',
            saslUsername: '',
            encryptedToken: 'secret-token-hex',
            loggingEnabled: true,
        },
        {
            hash: 'ext-1',
            name: 'Libera',
            serverType: 'external',
            loggingEnabled: false,
            externalServer: {
                connectionType: 'socket',
                host: 'irc.libera.chat',
                port: 6697,
                ssl: true,
                nickname: 'kenobi',
                saslUsername: 'kenobi',
                encryptedSaslPassword: 'secret-password-hex',
                authMethod: 'sasl_plain',
                websocketUrl: '',
                defaultChannel: '#libera',
            },
        },
    ];
}

test('the public view carries no tokens or passwords, only whether a password is set', () => {
    const [home, external] = storedProfiles().map(profile => publicProfile(profile, 'irc.example.org'));
    const serialized = JSON.stringify([home, external]);

    assert.ok(!serialized.includes('secret-token-hex'));
    assert.ok(!serialized.includes('secret-password-hex'));
    assert.equal(external.hasSaslPassword, true);
    assert.equal(home.hasSaslPassword, false);
    assert.equal(external.externalServer.host, 'irc.libera.chat');
    assert.equal(external.summary, 'kenobi · irc.libera.chat:6697 (TLS)');
    assert.equal(home.summary, 'irc.example.org · Obi_Wan');
});

test('editing keeps stored secrets and internal fields the page cannot see', () => {
    const result = applyConnectionUpdate(storedProfiles(), {
        hash: 'ext-1',
        name: 'Libera.Chat',
        externalServer: { host: 'irc.libera.chat', port: 6697, ssl: true, nickname: 'obiwan', saslUsername: 'kenobi' },
    });

    assert.equal(result.ok, true);
    const saved = result.profiles.find(profile => profile.hash === 'ext-1');
    assert.equal(saved.name, 'Libera.Chat');
    assert.equal(saved.externalServer.nickname, 'obiwan');
    assert.equal(saved.externalServer.encryptedSaslPassword, 'secret-password-hex');
    assert.equal(saved.externalServer.authMethod, 'sasl_plain');
    assert.equal(saved.loggingEnabled, false);
    assert.equal(result.profiles.find(profile => profile.hash === 'home-1').encryptedToken, 'secret-token-hex');
});

test('the page cannot smuggle secrets or other fields into a profile', () => {
    const result = applyConnectionUpdate(storedProfiles(), {
        hash: 'home-1',
        encryptedToken: 'forged',
        encryptedSaslPassword: 'forged',
        loggingEnabled: false,
        nickname: 'Obi_Wan',
    });

    const saved = result.profiles.find(profile => profile.hash === 'home-1');
    assert.equal(saved.encryptedToken, 'secret-token-hex');
    assert.equal(saved.encryptedSaslPassword, undefined);
    assert.equal(saved.loggingEnabled, true);

    const external = applyConnectionUpdate(storedProfiles(), {
        hash: 'ext-1',
        externalServer: { host: 'irc.libera.chat', port: 6697, encryptedSaslPassword: 'forged', authMethod: 'external' },
    });
    const ext = external.profiles.find(profile => profile.hash === 'ext-1').externalServer;
    assert.equal(ext.encryptedSaslPassword, 'secret-password-hex');
    assert.equal(ext.authMethod, 'sasl_plain');
});

test('invalid input is rejected with the same rules as the manager', () => {
    const result = applyConnectionUpdate(storedProfiles(), {
        hash: 'ext-1',
        externalServer: { host: 'ircs://irc.libera.chat/', port: 70000, nickname: '1nvalid nick' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors.host, 'connection_error_host_invalid');
    assert.equal(result.errors.port, 'connection_error_port');
    assert.equal(result.errors.nickname, 'connection_error_nickname');
});

test('a SASL user without a password is refused, a new password makes it valid', () => {
    const update = { serverType: 'external', externalServer: { host: 'irc.example.org', saslUsername: 'me' } };

    assert.equal(applyConnectionUpdate(storedProfiles(), update).errors.saslPassword, 'connection_error_sasl_password');

    const result = applyConnectionUpdate(storedProfiles(), { ...update, saslPassword: 'hunter2' });
    assert.equal(result.ok, true);
    assert.equal(result.saslPassword, 'hunter2');
    assert.equal(result.profile.externalServer.authMethod, 'sasl_plain');
    assert.equal(result.profile.externalServer.saslPassword, undefined, 'never stored in plain text');
});

test('new connections get their id from the main process, never from the page', () => {
    const result = applyConnectionUpdate(storedProfiles(), { serverType: 'home', nickname: 'Ahsoka', server: 'evil.example' }, { newHash: () => 'generated', primaryServer: 'st-city.net' });

    assert.equal(result.ok, true);
    assert.equal(result.profile.hash, 'generated');
    assert.equal(result.profile.serverType, 'home');
    assert.equal(result.profile.server, 'st-city.net', 'bound to the primary server, never to what the page says');
    assert.equal(result.profiles.length, 3);
});

test('without a primary server no home connection can be created', () => {
    const result = applyConnectionUpdate(storedProfiles(), { serverType: 'home', nickname: 'Ahsoka' });
    assert.equal(result.ok, false);
});

test('another server address drops the stored password and token, a new password is needed', () => {
    const profiles = storedProfiles();
    profiles[1].encryptedToken = 'ext-token';
    const moved = { hash: 'ext-1', externalServer: { host: 'irc.evil.example', port: 6697, ssl: true, nickname: 'kenobi', saslUsername: 'kenobi' } };
    assert.equal(applyConnectionUpdate(profiles, moved).errors.saslPassword, 'connection_error_sasl_password');

    const result = applyConnectionUpdate(profiles, { ...moved, saslPassword: 'new-one' });
    assert.equal(result.ok, true);
    assert.equal(result.profile.externalServer.encryptedSaslPassword, undefined);
    assert.equal(result.profile.encryptedToken, undefined);
    assert.equal(result.saslPassword, 'new-one', 'main encrypts the new password for the new server');

    const plain = applyConnectionUpdate(profiles, { hash: 'ext-1', externalServer: { ssl: false, saslUsername: 'kenobi' } });
    assert.equal(plain.ok, false, 'switching TLS off counts as another address: no stored password in plain text');
});

test('an unknown connection cannot be edited', () => {
    const result = applyConnectionUpdate(storedProfiles(), { hash: 'nope', nickname: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.errors.hash, 'connection_error_unknown');
});

test('the server type of an existing connection cannot be switched by the page', () => {
    const result = applyConnectionUpdate(storedProfiles(), { hash: 'home-1', serverType: 'external', externalServer: { host: 'evil.example' } });
    assert.equal(result.profiles.find(profile => profile.hash === 'home-1').serverType, 'home');
});

test('only existing connections can be deleted, and the last one stays', () => {
    assert.equal(canDeleteConnection(storedProfiles(), 'ext-1'), true);
    assert.equal(canDeleteConnection(storedProfiles(), 'nope'), false);
    assert.equal(canDeleteConnection([storedProfiles()[0]], 'home-1'), false);
});

test('connection tests are limited: one at a time, a pause between, a cap per window', () => {
    let time = 0;
    const limiter = createTestLimiter({ minIntervalMs: 2000, windowMs: 60000, maxPerWindow: 3, now: () => time });

    assert.equal(limiter.tryStart(), null);
    assert.equal(limiter.tryStart(), 'busy');
    limiter.finish();
    assert.equal(limiter.tryStart(), 'rate_limited', 'too soon after the last one');

    time = 2000;
    assert.equal(limiter.tryStart(), null);
    limiter.finish();
    time = 4000;
    assert.equal(limiter.tryStart(), null);
    limiter.finish();
    time = 6000;
    assert.equal(limiter.tryStart(), 'rate_limited', 'cap per window reached');

    time = 61000;
    assert.equal(limiter.tryStart(), null, 'the window moved on');
});

test('changing the network domain of a connection drops its credentials', () => {
    const stored = storedProfiles();
    const result = applyConnectionUpdate(stored, { hash: 'ext-1', externalServer: { domain: 'libera.chat' } });
    assert.equal(result.ok, false, 'the stored password was not meant for the API of that domain');
    assert.equal(result.errors.saslPassword, 'connection_error_sasl_password');
});

test('home profiles are bound to their primary server', () => {
    const profiles = [
        { hash: 'legacy', name: 'Old' },
        { hash: 'bound', serverType: 'home', server: 'st-city.net', encryptedToken: 'x' },
        { hash: 'other', serverType: 'home', server: 'other.example', encryptedToken: 'y' },
        { hash: 'libera', serverType: 'external', externalServer: { host: 'irc.libera.chat', port: 6697 } },
    ];

    const stcity = usableProfiles(profiles, 'st-city.net');
    assert.deepEqual(stcity.kept.map(profile => profile.hash), ['legacy', 'bound', 'libera']);
    assert.equal(stcity.kept[0].server, 'st-city.net', 'older profiles are bound on the first start');
    assert.equal(stcity.bound, 1);
    assert.deepEqual(stcity.dropped.map(profile => profile.hash), ['other'], 'credentials of another server never go to this one');

    const generic = usableProfiles(profiles, '');
    assert.deepEqual(generic.kept.map(profile => profile.hash), ['libera']);
    assert.equal(generic.dropped.length, 3);
    assert.deepEqual(usableProfiles(null, 'st-city.net'), { kept: [], dropped: [], bound: 0 });
});

test('credentials only for the server a profile belongs to', () => {
    assert.equal(mayUseCredentials({ serverType: 'home', server: 'st-city.net' }, 'st-city.net'), true);
    assert.equal(mayUseCredentials({ serverType: 'home', server: 'st-city.net' }, 'evil.example'), false);
    assert.equal(mayUseCredentials({ serverType: 'home' }, 'st-city.net'), false, 'unbound profiles are bound first');
    assert.equal(mayUseCredentials({ serverType: 'home', server: 'st-city.net' }, ''), false);
    assert.equal(mayUseCredentials({ serverType: 'external', externalServer: {} }, ''), true);
    assert.equal(mayUseCredentials(null, 'st-city.net'), false);
});

test('the shell window cannot set credentials or the bound server', () => {
    const stored = storedProfiles();
    const incoming = [
        { ...stored[0], server: 'evil.example', encryptedToken: 'forged', name: 'Renamed' },
        { ...stored[1], externalServer: { ...stored[1].externalServer, encryptedSaslPassword: 'forged' } },
        { hash: 'new-home', serverType: 'home', server: 'evil.example', encryptedToken: 'forged' },
    ];
    const merged = mergeShellProfiles(stored, incoming, 'st-city.net');
    assert.equal(merged[0].name, 'Renamed');
    assert.equal(merged[0].server, 'st-city.net');
    assert.equal(merged[0].encryptedToken, 'secret-token-hex');
    assert.equal(merged[1].externalServer.encryptedSaslPassword, 'secret-password-hex');
    assert.equal(merged[2].server, 'st-city.net');
    assert.equal(merged[2].encryptedToken, undefined);
});

test('a server change from the shell window drops the stored credentials', () => {
    const stored = storedProfiles();
    const moved = { ...stored[1], externalServer: { ...stored[1].externalServer, host: 'irc.evil.example' } };
    const [merged] = mergeShellProfiles(stored, [moved], 'st-city.net');
    assert.equal(merged.externalServer.host, 'irc.evil.example');
    assert.equal(merged.externalServer.encryptedSaslPassword, undefined);
    assert.notEqual(serverAddress(merged), serverAddress(stored[1]));
});
