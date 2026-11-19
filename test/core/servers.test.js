/**
 * Server list: validation, cache and fallbacks.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
    SERVER_LIST_URL,
    findServer,
    isSameSite,
    loadServerList,
    normalizeServer,
    normalizeServerList,
    resolveServers,
} from '../../src/core/servers.js';

const ergo = { id: 'ergo-testnet', name: 'Ergo Testnet', domain: 'testnet.ergo.chat', languages: ['en'], websocket: 'wss://testnet.ergo.chat/webirc' };
const libera = { id: 'libera', name: 'Libera.Chat', domain: 'libera.chat', languages: ['en'], irc: { host: 'irc.libera.chat', port: 6697, tls: true } };
const list = (servers) => ({ schemaVersion: 1, servers });

function memoryStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        data,
    };
}

function jsonFetch(body, { ok = true } = {}) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        return { ok, json: async () => body };
    };
    fn.calls = calls;
    return fn;
}

const failingFetch = async () => { throw new TypeError('offline'); };

test('subdomains count as the same site, lookalikes do not', () => {
    assert.ok(isSameSite('st-city.net', 'st-city.net'));
    assert.ok(isSameSite('Skynet.ST-City.net', 'st-city.net'));
    assert.ok(!isSameSite('evilst-city.net', 'st-city.net'));
    assert.ok(!isSameSite('st-city.net.evil.com', 'st-city.net'));
    assert.ok(!isSameSite(null, 'st-city.net'));
});

test('entries without endpoints or with bad fields are dropped', () => {
    assert.equal(normalizeServer({ ...ergo, websocket: undefined }), null);
    assert.equal(normalizeServer({ ...ergo, id: 'Bad ID' }), null);
    assert.equal(normalizeServer({ ...ergo, domain: 'localhost' }), null);
    assert.equal(normalizeServer({ ...ergo, websocket: 'ws://testnet.ergo.chat' }), null, 'plain ws is not allowed');
    assert.deepEqual(normalizeServer(libera).irc, { host: 'irc.libera.chat', port: 6697, tls: true });
    assert.equal(normalizeServer({ ...libera, irc: { host: 'x', port: 70000 } }), null);
});

test('a discovery link on a foreign host is ignored', () => {
    assert.equal(normalizeServer({ ...ergo, discovery: 'https://evil.example/starchat.json' }).discovery, undefined);
    assert.equal(normalizeServer({ ...ergo, discovery: 'https://www.testnet.ergo.chat/sc.json' }).discovery, 'https://www.testnet.ergo.chat/sc.json');
});

test('unknown schema versions are rejected, duplicate ids keep the first', () => {
    assert.equal(normalizeServerList({ schemaVersion: 2, servers: [ergo] }), null);
    assert.equal(normalizeServerList(null), null);
    const servers = normalizeServerList(list([ergo, { ...ergo, name: 'Copy' }, libera]));
    assert.deepEqual(servers.map((s) => s.name), ['Ergo Testnet', 'Libera.Chat']);
});

test('the shipped list is valid', async () => {
    const { servers, origin } = await loadServerList({ fetch: failingFetch, storage: null });
    assert.equal(origin, 'bundled');
    assert.ok(servers.length >= 1);
});

test('the public list is fetched and cached', async () => {
    const storage = memoryStorage();
    const fetch = jsonFetch(list([ergo]));
    const first = await loadServerList({ fetch, storage, now: () => 1000 });
    assert.equal(first.origin, 'network');
    assert.deepEqual(fetch.calls, [SERVER_LIST_URL]);

    const second = await loadServerList({ fetch, storage, now: () => 2000 });
    assert.equal(second.origin, 'cache');
    assert.equal(fetch.calls.length, 1, 'fresh cache needs no request');
    assert.equal(second.servers[0].id, 'ergo-testnet');
});

test('an expired cache is refreshed and used when the network fails', async () => {
    const storage = memoryStorage();
    await loadServerList({ fetch: jsonFetch(list([ergo])), storage, now: () => 0, ttl: 10 });

    const refreshed = await loadServerList({ fetch: jsonFetch(list([libera])), storage, now: () => 100, ttl: 10 });
    assert.equal(refreshed.origin, 'network');
    assert.equal(refreshed.servers[0].id, 'libera');

    const offline = await loadServerList({ fetch: failingFetch, storage, now: () => 500, ttl: 10 });
    assert.equal(offline.origin, 'stale');
    assert.equal(offline.servers[0].id, 'libera');
});

test('a broken response does not replace the cache', async () => {
    const storage = memoryStorage();
    await loadServerList({ fetch: jsonFetch(list([ergo])), storage, now: () => 0, ttl: 10 });
    const result = await loadServerList({ fetch: jsonFetch({ schemaVersion: 9 }), storage, now: () => 100, ttl: 10 });
    assert.equal(result.origin, 'stale');
    assert.equal(result.servers[0].id, 'ergo-testnet');
});

test('a custom list does not fall back to the public one', async () => {
    const result = await loadServerList({ source: 'https://irc.example.org/servers.json', fetch: failingFetch, storage: null });
    assert.deepEqual(result, { servers: [], origin: 'none' });
});

test('serverList false loads nothing', async () => {
    const fetch = jsonFetch(list([ergo]));
    assert.deepEqual(await loadServerList({ source: false, fetch }), { servers: [], origin: 'none' });
    assert.equal(fetch.calls.length, 0);
});

test('the primary server is found by id or domain, unknown domains become bare entries', () => {
    const servers = [ergo, libera].map(normalizeServer);
    assert.equal(findServer('libera', servers).id, 'libera');
    assert.equal(findServer('Libera.Chat', servers).id, 'libera');
    assert.deepEqual(findServer('irc.example.org', servers), { id: 'irc-example-org', name: 'irc.example.org', domain: 'irc.example.org', languages: [] });
    assert.equal(findServer('not a domain', servers), null);
    assert.equal(findServer(null, servers), null);
});

test('resolveServers puts the primary server first', async () => {
    const fetch = jsonFetch(list([ergo, libera]));
    const result = await resolveServers({ primaryServer: 'libera.chat' }, { fetch, storage: null });
    assert.deepEqual(result.servers.map((s) => s.id), ['libera', 'ergo-testnet']);
    assert.equal(result.primary.id, 'libera');

    const only = await resolveServers({ primaryServer: 'irc.example.org', serverList: false });
    assert.deepEqual(only.servers.map((s) => s.domain), ['irc.example.org']);
});
