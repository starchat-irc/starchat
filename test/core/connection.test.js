/**
 * Discovery and per-server connections.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { DISCOVERY_FEATURES, discoveryUrl, fetchDiscovery, normalizeDiscovery } from '../../src/core/discovery.js';
import { createConnection, openConnection } from '../../src/core/connection.js';

const server = { id: 'example', name: 'Example', domain: 'example.org', languages: ['en'], websocket: 'wss://irc.example.org' };
const discoveryData = {
    schemaVersion: 1,
    name: 'Example Net',
    websocketUrl: 'wss://ws.example.org/',
    apiBaseUrl: 'https://example.org/api/',
    auth: ['password', 'bearer'],
    features: ['friends', 'uploads', 'bad name', 7],
    branding: { logo: 'https://example.org/logo.svg', themeCss: 'http://cdn.example.net/theme.css' },
};

function recordingFetch(response) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init });
        if (response instanceof Error) {
            throw response;
        }
        return response;
    };
    fn.calls = calls;
    return fn;
}

const jsonResponse = (body, extra = {}) => ({ ok: true, url: '', json: async () => body, ...extra });

test('discovery is looked up on the server domain', () => {
    assert.equal(discoveryUrl(server), 'https://example.org/.well-known/starchat.json');
    assert.equal(discoveryUrl({ ...server, discovery: 'https://chat.example.org/sc.json' }), 'https://chat.example.org/sc.json');
    assert.equal(discoveryUrl({ ...server, discovery: 'https://evil.test/sc.json' }), 'https://example.org/.well-known/starchat.json');
    assert.equal(discoveryUrl({ ...server, discovery: 'http://example.org/sc.json' }), 'https://example.org/.well-known/starchat.json');
});

test('discovery keeps known values and secure endpoints', () => {
    const discovery = normalizeDiscovery(discoveryData);
    assert.equal(discovery.name, 'Example Net');
    assert.equal(discovery.websocketUrl, 'wss://ws.example.org');
    assert.equal(discovery.apiBaseUrl, 'https://example.org/api');
    assert.deepEqual(discovery.auth, ['bearer']);
    assert.deepEqual(discovery.features, ['friends', 'uploads']);
    assert.deepEqual(discovery.branding, { logo: 'https://example.org/logo.svg' }, 'http is dropped');
});

test('discovery keeps https links, invites only with their placeholder', () => {
    const discovery = normalizeDiscovery({
        ...discoveryData,
        links: {
            register: 'https://example.org/register',
            channelInvite: 'https://example.org/join/{channel}',
            communityInvite: 'https://example.org/invite/{community}',
            reportPolicy: 'http://example.org/policy',
            unknown: 'https://example.org/x',
        },
    });
    assert.deepEqual(discovery.links, {
        register: 'https://example.org/register',
        channelInvite: 'https://example.org/join/{channel}',
        communityInvite: 'https://example.org/invite/{community}',
    });
    assert.deepEqual(normalizeDiscovery({ ...discoveryData, links: { communityInvite: 'https://example.org/invite/{channel}' } }).links, {});
    assert.deepEqual(normalizeDiscovery({ ...discoveryData, links: { channelInvite: 'https://example.org/join' } }).links, {});
    assert.deepEqual(normalizeDiscovery({ ...discoveryData, links: { channelInvite: 'javascript:{channel}' } }).links, {});
    assert.deepEqual(normalizeDiscovery({ schemaVersion: 1, links: { register: 'https://example.org/r' } }).links,
        { register: 'https://example.org/r' }, 'links work without an API');
    assert.ok(normalizeDiscovery({ ...discoveryData, features: ['gifs'] }).features.includes('gifs'));
});

test('endpoints may be on other domains, but not without TLS', () => {
    const elsewhere = normalizeDiscovery({ ...discoveryData, apiBaseUrl: 'https://api.example.net/v1', websocketUrl: 'wss://ws.example.net' });
    assert.equal(elsewhere.apiBaseUrl, 'https://api.example.net/v1');
    assert.equal(elsewhere.websocketUrl, 'wss://ws.example.net');

    const insecure = normalizeDiscovery({ ...discoveryData, apiBaseUrl: 'http://example.org/api', websocketUrl: 'ws://example.org' });
    assert.equal(insecure.apiBaseUrl, null);
    assert.equal(insecure.websocketUrl, null);
    assert.deepEqual(insecure.features, [], 'no API, no features');
});

test('discovery needs a known schema version', () => {
    assert.equal(normalizeDiscovery({ ...discoveryData, schemaVersion: 2 }), null);
    assert.equal(normalizeDiscovery({ ...discoveryData, schemaVersion: undefined }), null);
    assert.equal(normalizeDiscovery([]), null);
    assert.deepEqual(normalizeDiscovery({ schemaVersion: 1 }).auth, ['sasl-plain', 'guest'], 'default login methods');
});

test('the documented example matches the schema and the client', () => {
    const read = (name) => JSON.parse(readFileSync(new URL(`../../docs/${name}`, import.meta.url), 'utf8'));
    const example = read('discovery.example.json');
    const validate = new Ajv2020({ allErrors: true }).compile(read('discovery.schema.json'));
    assert.ok(validate(example), JSON.stringify(validate.errors));
    assert.ok(!validate({ schemaVersion: 1, features: ['friends'] }), 'features need an API');
    assert.ok(!validate({ schemaVersion: 1, apiBaseUrl: 'http://example.org' }));

    const discovery = normalizeDiscovery(example);
    assert.deepEqual(discovery.auth, example.auth);
    assert.deepEqual(discovery.features, example.features);
    assert.deepEqual(discovery.branding, example.branding);
    assert.deepEqual(discovery.links, example.links);
});

test('the client knows exactly the features of the schema', () => {
    const schema = JSON.parse(readFileSync(new URL('../../docs/discovery.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual([...schema.properties.features.items.enum].sort(), [...DISCOVERY_FEATURES].sort());
});

test('fetchDiscovery returns null for missing files, errors and foreign redirects', async () => {
    assert.equal(await fetchDiscovery(server, { fetch: recordingFetch({ ok: false }) }), null);
    assert.equal(await fetchDiscovery(server, { fetch: recordingFetch(new TypeError('offline')) }), null);
    assert.equal(await fetchDiscovery(server, { fetch: recordingFetch(jsonResponse(discoveryData, { url: 'https://evil.test/x' })) }), null);
    const broken = { ok: true, url: '', json: async () => { throw new SyntaxError('bad'); } };
    assert.equal(await fetchDiscovery(server, { fetch: recordingFetch(broken) }), null);
});

test('fetchDiscovery sends no cookies and follows redirects within the domain', async () => {
    const fetch = recordingFetch(jsonResponse(discoveryData, { url: 'https://www.example.org/.well-known/starchat.json' }));
    const discovery = await fetchDiscovery(server, { fetch });
    assert.equal(discovery.apiBaseUrl, 'https://example.org/api');
    assert.equal(fetch.calls[0].init.credentials, 'omit');
});

test('without discovery a connection is plain IRC', () => {
    const connection = createConnection({ server });
    assert.equal(connection.websocketUrl, 'wss://irc.example.org');
    assert.equal(connection.name, 'Example');
    assert.equal(connection.hasFeature('friends'), false);
    assert.throws(() => connection.apiUrl('friends'), /no API/);
});

test('discovery switches on features and overrides the WebSocket URL', () => {
    const connection = createConnection({ server, discovery: normalizeDiscovery(discoveryData) });
    assert.equal(connection.websocketUrl, 'wss://ws.example.org');
    assert.equal(connection.name, 'Example Net');
    assert.ok(connection.hasFeature('friends'));
    assert.ok(!connection.hasFeature('voice'));
});

test('API paths cannot leave the API base', () => {
    const connection = createConnection({ server, discovery: normalizeDiscovery(discoveryData) });
    assert.equal(connection.apiUrl('friends'), 'https://example.org/api/friends');
    assert.equal(connection.apiUrl('/friends?x=1'), 'https://example.org/api/friends?x=1');
    for (const path of ['https://evil.test/x', '//evil.test/x', '../admin', 'a/../../x', '%2e%2e/x', '\\\\evil.test']) {
        assert.throws(() => connection.apiUrl(path), /relative/, path);
    }
});

test('each connection sends only its own token', async () => {
    const fetchA = recordingFetch(jsonResponse({}));
    const fetchB = recordingFetch(jsonResponse({}));
    const other = { ...server, id: 'other', domain: 'other.net' };
    const a = createConnection({ server, discovery: normalizeDiscovery(discoveryData), token: 'token-a', fetch: fetchA });
    const b = createConnection({ server: other, discovery: normalizeDiscovery({ schemaVersion: 1, apiBaseUrl: 'https://other.net/api' }), fetch: fetchB });

    await a.api('friends', { method: 'POST' });
    await b.api('friends');

    assert.equal(fetchA.calls[0].url, 'https://example.org/api/friends');
    assert.equal(fetchA.calls[0].init.method, 'POST');
    assert.equal(fetchA.calls[0].init.headers.get('Authorization'), 'Bearer token-a');
    assert.equal(fetchA.calls[0].init.credentials, 'omit');
    assert.equal(fetchB.calls[0].init.headers.get('Authorization'), null);

    b.setToken('token-b');
    assert.equal(a.getToken(), 'token-a');
    b.setToken('');
    assert.equal(b.getToken(), null);
});

test('openConnection combines list entry and discovery', async () => {
    const connection = await openConnection(server, { token: 't', fetch: recordingFetch(jsonResponse(discoveryData)) });
    assert.ok(connection.hasFeature('uploads'));
    assert.equal(connection.getToken(), 't');

    const plain = await openConnection(server, { fetch: recordingFetch({ ok: false }) });
    assert.equal(plain.discovery, null);
    assert.equal(plain.websocketUrl, 'wss://irc.example.org');
});
