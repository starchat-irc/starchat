/**
 * irc:// and ircs:// links: parsing and the profile they open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import links from '../irc-links.js';

const { parseIrcUrl, ircUrlFromArgs, profileForLink } = links;

test('ircs with port and channel in the fragment', () => {
    assert.deepEqual(parseIrcUrl('ircs://irc.libera.chat:6697/#libera'), { host: 'irc.libera.chat', port: 6697, tls: true, channel: '#libera' });
});

test('default ports, channel in the path, upper case and channel keys', () => {
    assert.deepEqual(parseIrcUrl('irc://IRC.OFTC.net/Debian'), { host: 'irc.oftc.net', port: 6667, tls: false, channel: '#debian' });
    assert.deepEqual(parseIrcUrl('ircs://irc.libera.chat/%23python,needkey'), { host: 'irc.libera.chat', port: 6697, tls: true, channel: '#python' });
    assert.equal(parseIrcUrl('ircs://irc.libera.chat').channel, '');
});

test('everything else is not a link for the app', () => {
    for (const url of ['https://libera.chat/', 'irc://', 'irc://user:pw@irc.example.org/', 'irc://irc.example.org:99999/', 'javascript:alert(1)', '', null]) {
        assert.equal(parseIrcUrl(url), null, String(url));
    }
    assert.equal(parseIrcUrl('ircs://irc.example.org/#two words').channel, '');
});

test('links arrive as command line arguments', () => {
    assert.equal(ircUrlFromArgs(['starchat.exe', '--flag', 'ircs://irc.libera.chat/#a']), 'ircs://irc.libera.chat/#a');
    assert.equal(ircUrlFromArgs(['starchat.exe']), null);
});

const profiles = [
    { hash: 'home', serverType: 'home' },
    { hash: 'libera', serverType: 'external', externalServer: { connectionType: 'socket', host: 'irc.libera.chat', port: 6697 } },
    { hash: 'oftc-ws', serverType: 'external', externalServer: { connectionType: 'websocket', websocketUrl: 'wss://irc.oftc.net/ws' } },
    { hash: 'libera-2', serverType: 'external', externalServer: { connectionType: 'socket', host: 'irc.libera.chat', port: 6697 } },
];

test('a link opens the profile of its server, the active one first', () => {
    assert.equal(profileForLink(profiles, { host: 'irc.libera.chat' }, 'example.org').hash, 'libera');
    assert.equal(profileForLink(profiles, { host: 'irc.libera.chat' }, 'example.org', 'libera-2').hash, 'libera-2');
    assert.equal(profileForLink(profiles, { host: 'irc.oftc.net' }, 'example.org').hash, 'oftc-ws');
});

test('the primary server and its subdomains open a home profile', () => {
    assert.equal(profileForLink(profiles, { host: 'example.org' }, 'example.org').hash, 'home');
    assert.equal(profileForLink(profiles, { host: 'irc.example.org' }, 'example.org').hash, 'home');
    assert.equal(profileForLink(profiles, { host: 'evil-example.org' }, 'example.org'), null);
});

test('an unknown server has no profile', () => {
    assert.equal(profileForLink(profiles, { host: 'irc.unknown.net' }, 'example.org'), null);
    assert.equal(profileForLink(null, { host: 'irc.libera.chat' }, 'example.org'), null);
});
