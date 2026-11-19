/**
 * Server and start channel chosen in the login dialog.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createPlainStore } from '../../src/core/store.js';
import { createConnection } from '../../src/core/connection.js';
import { createTranslator } from '../../src/i18n/index.js';
import { createChatComponent } from '../../src/ui/component.js';
import { createChannelManagementState } from '../../src/ui/mixins/channel-management.js';
import { domainFromInput, normalizeChannelName, OTHER_SERVER } from '../../src/ui/mixins/server-select.js';
import { installBrowserStubs } from './chat-harness.js';

const SERVERS = [
    { id: 'home', name: 'Home Net', domain: 'home.example.org', languages: ['de'], websocket: 'wss://home.example.org/ws' },
    { id: 'other', name: 'Other Net', domain: 'other.example.net', languages: ['en'], websocket: 'wss://other.example.net/ws' },
];

let storage;

beforeEach(() => {
    storage = installBrowserStubs();
});

function chatWithServers({ defaultChannel = '#starchat' } = {}) {
    const sockets = [];
    const opened = [];
    const chat = createChatComponent({
        connection: createConnection({ server: SERVERS[0] }),
        servers: SERVERS,
        defaultChannel,
        t: createTranslator({ locale: 'en' }),
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
        openServerConnection: async (server) => {
            opened.push(server);
            return createConnection({ server });
        },
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
    return { chat, sockets, opened };
}

test('channel names from the start channel field', () => {
    assert.equal(normalizeChannelName('#StarChat'), '#starchat');
    assert.equal(normalizeChannelName('starchat'), '#starchat');
    assert.equal(normalizeChannelName('  '), '');
    assert.equal(normalizeChannelName('#two words'), null);
    assert.equal(domainFromInput('https://IRC.Example.org:443/webirc'), 'irc.example.org');
});

test('the primary server and the default start channel are preselected', async () => {
    const { chat, sockets, opened } = chatWithServers();
    assert.equal(chat.selectedServerId, 'home');
    assert.equal(chat.startChannel, '#starchat');
    assert.equal(chat.loginSummary(), 'Home Net · #starchat');

    chat.loginUsername = 'alice';
    await chat.guestLogin();

    assert.deepEqual(opened, []);
    assert.equal(sockets[0].options.url, 'wss://home.example.org/ws');
    assert.equal(sockets[0].options.nickname, 'alice');
    assert.equal(chat.currentChannel, '#starchat');
    assert.deepEqual(chat.availableChannels, ['#starchat']);
});

test('another server of the list gets its own connection and drops old messages', async () => {
    const { chat, sockets, opened } = chatWithServers();
    chat.messageManager.add('#old', { text: 'from home' });
    chat.selectedServerId = 'other';
    chat.startChannel = 'help';
    chat.loginUsername = 'alice';
    await chat.guestLogin();

    assert.deepEqual(opened.map(server => server.id), ['other']);
    assert.equal(chat.serverName, 'Other Net');
    assert.equal(chat.storageScope, 'other');
    assert.deepEqual(chat.messageManager.keys(), []);
    assert.equal(sockets[0].options.url, 'wss://other.example.net/ws');
    assert.equal(chat.currentChannel, '#help');
});

test('any other domain, with an own WebSocket address', async () => {
    const { chat, sockets, opened } = chatWithServers();
    chat.selectedServerId = OTHER_SERVER;
    chat.customServerDomain = 'https://irc.example.com/';
    chat.customWebsocketUrl = 'wss://irc.example.com/webirc';
    await chat.guestLogin();

    assert.equal(opened[0].domain, 'irc.example.com');
    assert.equal(opened[0].websocket, 'wss://irc.example.com/webirc');
    assert.equal(sockets[0].options.url, 'wss://irc.example.com/webirc');
});

test('wrong input keeps the login dialog open with a hint', async () => {
    const { chat, sockets } = chatWithServers();
    chat.selectedServerId = OTHER_SERVER;
    chat.customServerDomain = 'irc.example.com';
    chat.customWebsocketUrl = 'ws://irc.example.com/plain';
    await chat.guestLogin();
    assert.equal(chat.loginError, 'The WebSocket address must start with wss://.');

    chat.customServerDomain = 'not a domain';
    chat.customWebsocketUrl = '';
    await chat.guestLogin();
    assert.equal(chat.loginError, 'Please enter a valid domain, e.g. irc.example.org.');

    chat.selectedServerId = 'home';
    chat.startChannel = '#two words';
    await chat.guestLogin();
    assert.equal(chat.loginError, 'The start channel is not a valid channel name.');

    assert.equal(sockets.length, 0);
    assert.equal(chat.isAuthenticated, false);
});

test('a server without a WebSocket address cannot be used in the browser', async () => {
    const { chat, sockets } = chatWithServers();
    chat.selectedServerId = OTHER_SERVER;
    chat.customServerDomain = 'irc.example.com';
    await chat.guestLogin();
    assert.equal(chat.loginError, chat.t('server_no_websocket'));
    assert.equal(sockets.length, 0);
});

test('without a start channel the server window opens', async () => {
    const { chat } = chatWithServers();
    chat.startChannel = '';
    await chat.guestLogin();
    assert.equal(chat.currentChannel, 'Server');
    assert.deepEqual(chat.availableChannels, []);
});

test('a server that never lets us register brings the login dialog back', async () => {
    const { chat } = chatWithServers();
    await chat.guestLogin();
    chat.handleSocketStatus('error');
    chat.handleSocketStatus('disconnected');
    chat.handleSocketStatus('disconnected');
    assert.equal(chat.isAuthenticated, true);
    chat.handleSocketStatus('disconnected');

    assert.equal(chat.isAuthenticated, false);
    assert.equal(chat.performLogout, true);
    assert.match(chat.loginError, /Could not connect/);
});

test('after a successful registration disconnects only reconnect', async () => {
    const { chat } = chatWithServers();
    await chat.guestLogin();
    chat.setConnectionState('connected');
    for (let i = 0; i < 5; i++) chat.handleSocketStatus('disconnected');
    assert.equal(chat.isAuthenticated, true);
});

test('the last choice is preselected next time', async () => {
    const first = chatWithServers().chat;
    first.selectedServerId = 'other';
    first.startChannel = '#help';
    first.loginUsername = 'alice';
    await first.guestLogin();
    assert.ok(storage.has('starchat.login'));

    const next = chatWithServers().chat;
    assert.equal(next.selectedServerId, 'other');
    assert.equal(next.startChannel, '#help');
    assert.equal(next.loginNickPreset, 'alice');
});
