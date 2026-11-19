/**
 * Login through the embedding page: token handshake with the parent window and the
 * bearer login of the chat component.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createPlainStore } from '../../src/core/store.js';
import { createConnection } from '../../src/core/connection.js';
import { createTranslator } from '../../src/i18n/index.js';
import { createChatComponent } from '../../src/ui/component.js';
import { createChannelManagementState } from '../../src/ui/mixins/channel-management.js';
import { bearerFromParent, readBearerLogin } from '../../src/ui/embed.js';
import { installBrowserStubs } from './chat-harness.js';

/** An iframe window with its parent; dispatch() delivers a message event. */
function frameWindow({ origin = 'https://chat.example.org', framed = true } = {}) {
    const listeners = new Set();
    const parent = { posted: [], postMessage(data, targetOrigin) { this.posted.push({ data, targetOrigin }); } };
    const win = {
        location: { origin },
        addEventListener: (type, listener) => listeners.add(listener),
        removeEventListener: (type, listener) => listeners.delete(listener),
        dispatch(event) { for (const listener of [...listeners]) listener(event); },
        listenerCount: () => listeners.size,
    };
    win.parent = framed ? parent : win;
    return { win, parent };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

test('the request goes only to the allowed origins and the chat\'s own', () => {
    const { win, parent } = frameWindow();
    bearerFromParent({ allowedOrigins: ['https://game.example.net'], window: win })();
    assert.deepEqual(parent.posted.map(entry => entry.targetOrigin), ['https://chat.example.org', 'https://game.example.net']);
    assert.deepEqual(parent.posted[0].data, { type: 'get-token' });
});

test('a token from an allowed parent is taken', async () => {
    const { win, parent } = frameWindow();
    const pending = bearerFromParent({ allowedOrigins: ['https://game.example.net'], window: win })();
    win.dispatch({ source: parent, origin: 'https://game.example.net', data: { type: 'token-response', token: ' abc ', account: 'Alice' } });
    assert.deepEqual(await pending, { token: 'abc', account: 'Alice', nickname: '', tokenType: 'jwt' });
    assert.equal(win.listenerCount(), 0);
});

test('answers from other origins or other windows are ignored', async () => {
    const { win, parent } = frameWindow();
    const pending = bearerFromParent({ allowedOrigins: ['https://game.example.net'], timeout: 1000, window: win })();
    win.dispatch({ source: parent, origin: 'https://evil.example.com', data: { type: 'token-response', token: 'evil' } });
    win.dispatch({ source: {}, origin: 'https://game.example.net', data: { type: 'token-response', token: 'other-frame' } });
    vi.advanceTimersByTime(1000);
    assert.equal(await pending, null);
});

test('without an answer the call ends with null after the timeout', async () => {
    const { win } = frameWindow();
    const pending = bearerFromParent({ timeout: 500, window: win })();
    vi.advanceTimersByTime(500);
    assert.equal(await pending, null);
    assert.equal(win.listenerCount(), 0);
});

test('a page that is not framed does not ask anyone', async () => {
    const { win } = frameWindow({ framed: false });
    assert.equal(await bearerFromParent({ window: win })(), null);
});

test('wildcards and paths are refused as origins', () => {
    const { win } = frameWindow();
    assert.throws(() => bearerFromParent({ allowedOrigins: ['*'], window: win }), /not allowed/);
    assert.throws(() => bearerFromParent({ allowedOrigins: ['https://game.example.net/play'], window: win }), /not an origin/);
    assert.doesNotThrow(() => bearerFromParent({ allowedOrigins: ['https://game.example.net/'], window: win }));
});

test('an answer without token is no login', () => {
    assert.equal(readBearerLogin({ type: 'token-response', token: '  ' }), null);
    assert.equal(readBearerLogin({ type: 'token-response', token: 42 }), null);
    assert.equal(readBearerLogin({ type: 'token', token: 't', tokenType: 'oauth2' }).tokenType, 'oauth2');
});

const SERVERS = [
    { id: 'home', name: 'Home Net', domain: 'home.example.org', websocket: 'wss://home.example.org/ws' },
    { id: 'other', name: 'Other Net', domain: 'other.example.net', websocket: 'wss://other.example.net/ws' },
];

function chatWithBearer(bearer) {
    installBrowserStubs();
    const sockets = [];
    const chat = createChatComponent({
        connection: createConnection({ server: SERVERS[0] }),
        servers: SERVERS,
        defaultChannel: '#lobby',
        bearer,
        t: createTranslator({ locale: 'en' }),
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
        openServerConnection: async (server) => createConnection({ server }),
        connectSocket: (options) => {
            const socket = { options, send() {}, close() {}, quit() {} };
            sockets.push(socket);
            return socket;
        },
    });
    chat.$nextTick = (callback) => callback?.();
    chat.$refs = {};
    chat.setupMediaPlayers = () => {};
    chat.setupStickToBottom = () => {};
    return { chat, sockets };
}

test('a token from the embedding page logs in on the primary server with IRCV3BEARER', async () => {
    const { chat, sockets } = chatWithBearer(async () => ({ token: 'jwt-1', account: '', nickname: 'Alice' }));
    chat.selectedServerId = 'other'; // remembered from an earlier visit
    await chat.bearerLogin();

    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].options.url, 'wss://home.example.org/ws');
    assert.equal(sockets[0].options.nickname, 'Alice');
    assert.equal(sockets[0].options.sasl.mechanism, 'IRCV3BEARER');
    assert.equal(sockets[0].options.sasl.payload(), '\0jwt\0jwt-1');
    assert.equal(chat.isAuthenticated, true);
});

test('each reconnect asks for a fresh token', async () => {
    let count = 0;
    const { chat, sockets } = chatWithBearer(async () => ({ token: `jwt-${++count}`, account: 'alice' }));
    await chat.bearerLogin();
    assert.equal(sockets[0].options.nickname, 'alice');

    await sockets[0].options.beforeReconnect();
    assert.equal(sockets[0].options.sasl.payload(), 'alice\0jwt\0jwt-2');
});

test('a failed refresh keeps the last token', async () => {
    let fail = false;
    const { chat, sockets } = chatWithBearer(async () => {
        if (fail) throw new Error('parent gone');
        return { token: 'jwt-1' };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chat.bearerLogin();
    fail = true;
    await sockets[0].options.beforeReconnect();
    assert.equal(sockets[0].options.sasl.payload(), '\0jwt\0jwt-1');
});

test('without an answer the login dialog stays', async () => {
    const { chat, sockets } = chatWithBearer(async () => null);
    await chat.bearerLogin();
    assert.equal(sockets.length, 0);
    assert.equal(chat.isAuthenticated, false);
    assert.equal(chat.isLoading, false);
});

test('the token is never sent to another server', async () => {
    const { chat, sockets } = chatWithBearer(async () => ({ token: 'jwt-1' }));
    await chat.bearerLogin();
    chat.logout();

    chat.selectedServerId = 'other';
    chat.loginUsername = 'bob';
    await chat.guestLogin();

    const last = sockets.at(-1);
    assert.equal(last.options.url, 'wss://other.example.net/ws');
    assert.equal(last.options.sasl, null);
    assert.equal(last.options.beforeReconnect, undefined);
});
