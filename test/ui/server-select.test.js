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
import { domainFromInput, normalizeChannelName, OTHER_SERVER, requestedChannelList } from '../../src/ui/mixins/server-select.js';
import { installBrowserStubs } from './chat-harness.js';

const SERVERS = [
    { id: 'home', name: 'Home Net', domain: 'home.example.org', languages: ['de'], websocket: 'wss://home.example.org/ws' },
    { id: 'other', name: 'Other Net', domain: 'other.example.net', languages: ['en'], websocket: 'wss://other.example.net/ws' },
];

let storage;

beforeEach(() => {
    storage = installBrowserStubs();
});

function chatWithServers({ defaultChannel = '#starchat', channels = [] } = {}) {
    const sockets = [];
    const opened = [];
    const chat = createChatComponent({
        connection: createConnection({ server: SERVERS[0] }),
        servers: SERVERS,
        defaultChannel,
        channels,
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

function chatForServer(server, options = {}) {
    const sockets = { websocket: [], native: [] };
    const fake = kind => (socketOptions) => {
        const socket = { options: socketOptions, send() {}, close() {}, quit() {} };
        sockets[kind].push(socket);
        return socket;
    };
    const chat = createChatComponent({
        connection: createConnection({ server }),
        servers: [server],
        t: createTranslator({ locale: 'en' }),
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
        connectSocket: fake('websocket'),
        ...options,
        ...(options.nativeSocket === true ? { nativeSocket: fake('native') } : {}),
    });
    chat.$nextTick = (callback) => callback?.();
    chat.$refs = {};
    chat.setupMediaPlayers = () => {};
    chat.setupStickToBottom = () => {};
    return { chat, sockets };
}

const TCP_ONLY = { id: 'libera', name: 'Libera', domain: 'libera.chat', languages: ['en'], irc: { host: 'irc.libera.chat', port: 6697, tls: true } };

test('a server without WebSocket connects over TCP when the app can open sockets', async () => {
    const { chat, sockets } = chatForServer(TCP_ONLY, { nativeSocket: true });
    chat.loginUsername = 'alice';
    await chat.guestLogin();
    assert.equal(sockets.websocket.length, 0);
    assert.deepEqual(sockets.native[0].options.irc, { host: 'irc.libera.chat', port: 6697, tls: true });
    assert.equal(chat.loginError, '');
});

test('without native sockets a TCP-only server cannot be used', async () => {
    const { chat, sockets } = chatForServer(TCP_ONLY);
    chat.loginUsername = 'alice';
    await chat.guestLogin();
    assert.equal(sockets.websocket.length, 0);
    assert.equal(chat.loginError, chat.t('server_no_websocket'));
});

test('WebSocket wins when a server offers both', async () => {
    const { chat, sockets } = chatForServer({ ...TCP_ONLY, websocket: 'wss://web.libera.chat/' }, { nativeSocket: true });
    chat.loginUsername = 'alice';
    await chat.guestLogin();
    assert.equal(sockets.native.length, 0);
    assert.equal(sockets.websocket[0].options.url, 'wss://web.libera.chat/');
});

test('SASL PLAIN logs into the given account, the login form uses the nick again', async () => {
    const { chat, sockets } = chatForServer(TCP_ONLY, { nativeSocket: true, nickname: 'obi', password: 'pw', saslAccount: 'ObiWan' });
    await chat.connect();
    const sasl = sockets.native[0].options.sasl;
    assert.equal(sasl.mechanism, 'PLAIN');
    assert.equal(sasl.payload(), 'ObiWan ObiWan pw');
    assert.equal(sockets.native[0].options.nickname, 'obi');

    chat.loginUsername = 'obi';
    chat.loginPassword = 'pw';
    await chat.login();
    assert.equal(sockets.native[1].options.sasl.payload(), 'obi obi pw');
});

test('desktop: a token from a password login goes to the app with the remember choice', () => {
    const messages = [];
    const { chat } = chatForServer(TCP_ONLY, { shell: 'desktop', notifyHost: (type, data = {}) => messages.push({ type, ...data }) });
    chat._apiLogin = { token: 'jwt' };
    chat.rememberMe = true;
    chat.saveShellLogin();
    assert.deepEqual(messages, [{ type: 'save-credentials', token: 'jwt', remember: true }]);
});

test('the web chat never hands a token to the page around it', () => {
    const messages = [];
    const { chat } = chatForServer(TCP_ONLY, { notifyHost: (type, data = {}) => messages.push({ type, ...data }) });
    chat._apiLogin = { token: 'jwt' };
    chat.rememberMe = true;
    chat.saveShellLogin();
    assert.deepEqual(messages, []);
});

test('an unreachable server shows the login dialog without telling the app to forget the login', () => {
    const messages = [];
    const { chat } = chatForServer(TCP_ONLY, { shell: 'desktop', notifyHost: (type) => messages.push(type) });
    chat.isAuthenticated = true;
    for (let attempt = 0; attempt < 10 && chat.isAuthenticated; attempt++) chat.handleSocketStatus('disconnected');
    assert.equal(chat.isAuthenticated, false);
    assert.equal(chat.loginError, chat.t('server_unreachable'));
    assert.ok(!messages.includes('logout'));

    chat.isAuthenticated = true;
    chat.performLogout = false;
    chat.logout();
    assert.ok(messages.includes('logout'), 'a logout of the user is passed on');
});

test('at start the chat asks the app around it for its settings and subscribes to its messages', () => {
    globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
    globalThis.document.addEventListener = () => {};
    const messages = [];
    let shellListener = null;
    const { chat } = chatForServer(TCP_ONLY, {
        shell: 'desktop',
        notifyHost: (type) => messages.push(type),
        shellMessages: (listener) => { shellListener = listener; },
    });
    chat.setupMobileLayout = () => {};
    chat.applyTheme = () => {};
    chat.init();
    assert.ok(messages.includes('settings-get'));
    assert.equal(typeof shellListener, 'function');

    const web = chatForServer(TCP_ONLY, { notifyHost: (type) => messages.push(`web:${type}`) }).chat;
    web.setupMobileLayout = () => {};
    web.applyTheme = () => {};
    web.init();
    assert.ok(!messages.includes('web:settings-get'), 'the web chat has no app to ask');
    delete globalThis.window;
});

test('the last start channel is only used for the server it was chosen on', () => {
    storage.set('starchat.login', JSON.stringify({ serverId: 'st-city-net', channel: '#starchat', nick: 'alice' }));
    const { chat } = chatForServer({ ...TCP_ONLY, id: 'profile-mock' }, { defaultChannel: '#test' });
    assert.equal(chat.startChannel, '#test');

    storage.set('starchat.login', JSON.stringify({ serverId: 'profile-mock', channel: '#chosen' }));
    assert.equal(chatForServer({ ...TCP_ONLY, id: 'profile-mock' }, { defaultChannel: '#test' }).chat.startChannel, '#chosen');
});

test('an app can store settings per connection instead of per server', () => {
    storage.set('chat.ignoredUsers:abc-123', JSON.stringify(['troll']));
    const { chat } = chatForServer(TCP_ONLY, { storageScope: 'abc-123' });
    assert.equal(chat.storageScope, 'abc-123');
    assert.deepEqual(chat.ignoredUsers, ['troll']);
    assert.equal(chatForServer(TCP_ONLY).chat.storageScope, 'libera', 'the server id by default');
});

test('with a storage scope each connection remembers its own login', async () => {
    const first = chatForServer(TCP_ONLY, { storageScope: 'account-a', nativeSocket: true }).chat;
    first.loginUsername = 'alice';
    await first.guestLogin();
    assert.equal(chatForServer(TCP_ONLY, { storageScope: 'account-a' }).chat.loginNickPreset, 'alice');
    assert.equal(chatForServer(TCP_ONLY, { storageScope: 'account-b' }).chat.loginNickPreset, '', 'the other account does not get alice');
    assert.equal(storage.get('starchat.login'), undefined, 'the web key stays untouched');
});

test('channels the page asks for are normalized', () => {
    assert.deepEqual(requestedChannelList('avalon, #Avalon,#bar,two words,'), ['#avalon', '#bar']);
    assert.deepEqual(requestedChannelList(['#Lobby', 'lobby']), ['#lobby']);
    assert.deepEqual(requestedChannelList(undefined), []);
});

test('a requested channel wins over the remembered one, all requested channels are joined', async () => {
    storage.set('starchat.login', JSON.stringify({ serverId: 'other', channel: '#remembered', nick: 'alice' }));
    const { chat, sockets, opened } = chatWithServers({ channels: 'avalon,#avalon-bar' });

    assert.equal(chat.selectedServerId, 'home', 'requested channels belong to the primary server');
    assert.equal(chat.startChannel, '#avalon');
    assert.deepEqual(chat.requestedChannels, ['#avalon', '#avalon-bar'], 'shown as invitation in the login dialog');

    chat.loginUsername = 'alice';
    await chat.guestLogin();

    assert.deepEqual(opened, []);
    assert.equal(sockets.length, 1);
    assert.equal(chat.currentChannel, '#avalon');
    assert.deepEqual(chat.availableChannels, ['#avalon', '#avalon-bar']);
});

test('a link does not replace the start channel the user chose', async () => {
    storage.set('starchat.login', JSON.stringify({ serverId: 'home', channel: '#mine', nick: 'alice' }));
    const { chat } = chatWithServers({ channels: '#avalon' });
    assert.equal(chat.startChannel, '#avalon');
    chat.loginUsername = 'alice';
    await chat.guestLogin();
    assert.equal(JSON.parse(storage.get('starchat.login')).channel, '#mine');

    storage.set('starchat.login', JSON.stringify({ serverId: 'home', channel: '#mine', nick: 'alice' }));
    const typed = chatWithServers({ channels: '#avalon' }).chat;
    typed.startChannel = '#typed';
    typed.loginUsername = 'alice';
    await typed.guestLogin();
    assert.equal(JSON.parse(storage.get('starchat.login')).channel, '#typed', 'a channel typed in the dialog is remembered');
    assert.deepEqual(typed.availableChannels, ['#typed', '#avalon']);
});

test('requested channels are not joined on another server chosen in the dialog', async () => {
    const { chat } = chatWithServers({ channels: '#avalon' });
    chat.selectedServerId = 'other';
    chat.startChannel = '#help';
    chat.loginUsername = 'alice';
    await chat.guestLogin();
    assert.deepEqual(chat.availableChannels, ['#help']);
});

test('without requested channels the remembered start channel stays', () => {
    storage.set('starchat.login', JSON.stringify({ serverId: 'home', channel: '#mine', nick: 'alice' }));
    const { chat } = chatWithServers();
    assert.equal(chat.startChannel, '#mine');
    assert.deepEqual(chat.requestedChannels, []);
});
