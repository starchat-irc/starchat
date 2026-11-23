import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell/controller.mjs';

/** A chat iframe: what the shell posts to it, and a window to send from. */
function fakeFrame(hash) {
    const received = [];
    return { hash, received, contentWindow: { postMessage: message => received.push(message) } };
}

function setUp({ profileList = ['a', 'b'], active = 'a' } = {}) {
    const calls = [];
    const record = (name, result = undefined) => async (args) => {
        calls.push([name, args]);
        return typeof result === 'function' ? result(args) : result;
    };
    const plugin = {
        socketConnect: record('socketConnect'),
        socketSend: record('socketSend'),
        socketClose: record('socketClose'),
        pushSubscribe: record('pushSubscribe', { fcmToken: 'fcm', p256dh: 'p', auth: 'a' }),
        pushUnsubscribe: record('pushUnsubscribe'),
        setPushFilter: record('setPushFilter'),
        openExternal: record('openExternal'),
        openNotificationSettings: record('openNotificationSettings'),
        takePendingShare: record('takePendingShare', { text: 'shared link' }),
    };
    const app = {
        getInfo: async () => ({ version: '0.1.0' }),
        minimizeApp: record('minimizeApp'),
    };
    let activeHash = active;
    const tokens = {};
    const profiles = {
        get profiles() { return profileList.map(hash => ({ hash })); },
        get active() { return activeHash; },
        setActive: async hash => {
            if (!profileList.includes(hash)) return false;
            activeHash = hash;
            return true;
        },
        configFor: async hash => ({ profileHash: hash }),
        label: hash => `Net ${hash}`,
        nickname: hash => `nick-${hash}`,
        setToken: async (hash, token) => { tokens[hash] = token; },
        setSaslLogin: async (hash, account, password) => { tokens[hash] = { account, password }; },
        clearLogin: async (hash) => { tokens[hash] = null; },
        setNickname: async () => {},
        request: async (action, payload) => {
            if (action === 'open') return { ok: true, open: payload.hash };
            if (action === 'delete') {
                profileList.splice(profileList.indexOf(payload.hash), 1);
                activeHash = profileList[0];
                return { ok: true, profiles: [], deleted: payload.hash };
            }
            return { ok: true, action };
        },
    };
    const frames = [];
    const ui = {
        drawerOpen: false,
        welcome: false,
        rendered: [],
        showChat(hash, onLoad) {
            const frame = fakeFrame(hash);
            frames.push(frame);
            // Like an iframe: loaded after the shell has taken it
            setImmediate(onLoad);
            return frame;
        },
        showWelcome() { this.welcome = true; },
        setReady() {},
        renderConnections(entries) { this.rendered = entries; },
        openDrawer() { this.drawerOpen = true; },
        closeDrawer() { this.drawerOpen = false; },
        isDrawerOpen() { return this.drawerOpen; },
    };
    const shell = createShell({ plugin, app, profiles, ui, locale: 'de', theme: () => 'dark' });
    const fromChat = (frame, data) => shell.handleMessage({ source: frame.contentWindow, data });
    const loaded = () => new Promise(resolve => setImmediate(resolve));
    return { shell, plugin, calls, ui, frames, tokens, fromChat, loaded, current: () => frames.at(-1) };
}

let env;
beforeEach(async () => {
    env = setUp();
    await env.shell.start();
    await env.loaded();
});

test('the remembered connection starts with its profile and theme', () => {
    const frame = env.current();
    assert.equal(frame.hash, 'a');
    assert.deepEqual(frame.received, [
        { type: 'init-chat-config', config: { profileHash: 'a' } },
        { type: 'set-theme', theme: 'dark' },
    ]);
    assert.deepEqual(env.ui.rendered.map(entry => [entry.hash, entry.active]), [['a', true], ['b', false]]);
    assert.deepEqual(env.ui.rendered.map(entry => entry.nickname), ['nick-a', 'nick-b']);
});

test('without connections the start screen shows', async () => {
    const empty = setUp({ profileList: [], active: '' });
    await empty.shell.start();
    assert.equal(empty.ui.welcome, true);
    assert.equal(empty.frames.length, 0);
});

test('socket lines go to the plugin, events only to the chat that opened the socket', async () => {
    const frame = env.current();
    await env.fromChat(frame, { type: 'native-socket-connect', data: { connectionId: 'n1', host: 'irc.libera.chat', port: 6697, ssl: true } });
    await env.fromChat(frame, { type: 'native-socket-send', data: { connectionId: 'n1', line: 'NICK kenobi' } });
    await env.fromChat(frame, { type: 'native-socket-send', data: { connectionId: 'n1', quitMessage: 'bye' } });
    assert.deepEqual(env.calls.slice(0, 2), [
        ['socketConnect', { connectionId: 'n1', host: 'irc.libera.chat', port: 6697, ssl: true }],
        ['socketSend', { connectionId: 'n1', line: 'NICK kenobi' }],
    ]);

    frame.received.length = 0;
    env.shell.handleSocketEvent({ connectionId: 'n1', event: 'message', data: ':irc 001 kenobi :hi' });
    env.shell.handleSocketEvent({ connectionId: 'other', event: 'message', data: 'not for this chat' });
    assert.deepEqual(frame.received, [{ type: 'native-socket-event', connectionId: 'n1', event: 'message', data: ':irc 001 kenobi :hi', error: undefined }]);
});

test('switching the connection closes the sockets of the old chat', async () => {
    const first = env.current();
    await env.fromChat(first, { type: 'native-socket-connect', data: { connectionId: 'n1', host: 'irc.libera.chat', port: 6697 } });
    await env.fromChat(first, { type: 'connections-request', id: 'r1', action: 'open', payload: { hash: 'b' } });
    await env.loaded();

    assert.deepEqual(first.received.at(-1), { type: 'connections-response', id: 'r1', result: { ok: true } });
    assert.deepEqual(env.calls.at(-1), ['socketClose', { connectionId: 'n1' }]);
    assert.equal(env.current().hash, 'b');

    // The old page is gone: its messages are ignored
    await env.fromChat(first, { type: 'native-socket-connect', data: { connectionId: 'n2', host: 'x.org', port: 6697 } });
    assert.ok(!env.calls.some(([name, args]) => name === 'socketConnect' && args.connectionId === 'n2'));
});

test('deleting the connection on screen opens the next one and drops its push keys', async () => {
    await env.fromChat(env.current(), { type: 'connections-request', id: 'r2', action: 'delete', payload: { hash: 'a' } });
    assert.ok(env.calls.some(([name, args]) => name === 'pushUnsubscribe' && args.profile === 'a'));
    assert.equal(env.current().hash, 'b');
});

test('deleting the last connection goes back to the start screen', async () => {
    const single = setUp({ profileList: ['a'], active: 'a' });
    await single.shell.start();
    await single.loaded();
    await single.fromChat(single.current(), { type: 'native-socket-connect', data: { connectionId: 'n1', host: 'irc.libera.chat', port: 6697 } });
    await single.fromChat(single.current(), { type: 'connections-request', id: 'r3', action: 'delete', payload: { hash: 'a' } });
    assert.equal(single.ui.welcome, true);
    assert.equal(single.frames.length, 1, 'no chat opened for a connection that is gone');
    assert.ok(single.calls.some(([name, args]) => name === 'socketClose' && args.connectionId === 'n1'));
});

test('logins, push and links are kept per connection', async () => {
    const frame = env.current();
    await env.fromChat(frame, { type: 'save-credentials', token: 'tok', remember: false });
    assert.deepEqual(env.tokens, { a: 'tok' });
    await env.fromChat(frame, { type: 'save-credentials', saslAccount: 'kenobi', saslPassword: 'pw' });
    assert.deepEqual(env.tokens, { a: { account: 'kenobi', password: 'pw' } }, 'a SASL login on a server without token login');
    await env.fromChat(frame, { type: 'save-credentials', token: 'tok', remember: false });

    await env.fromChat(frame, { type: 'push-subscribe' });
    assert.deepEqual(env.calls.find(([name]) => name === 'pushSubscribe'), ['pushSubscribe', { profile: 'a', name: 'Net a' }]);
    assert.deepEqual(frame.received.at(-1), { type: 'push-subscription', fcmToken: 'fcm', p256dh: 'p', auth: 'a' });

    await env.fromChat(frame, { type: 'push-filter', muted: ['#x'], ignored: 'not a list' });
    assert.deepEqual(env.calls.at(-1), ['setPushFilter', { profile: 'a', muted: ['#x'], ignored: [], calls: true }]);
    await env.fromChat(frame, { type: 'push-filter', muted: [], ignored: [], calls: false });
    assert.deepEqual(env.calls.at(-1), ['setPushFilter', { profile: 'a', muted: [], ignored: [], calls: false }]);

    await env.fromChat(frame, { type: 'open-external', url: 'javascript:alert(1)' });
    await env.fromChat(frame, { type: 'open-external', url: 'https://example.org' });
    assert.deepEqual(env.calls.filter(([name]) => name === 'openExternal'), [['openExternal', { url: 'https://example.org' }]]);

    await env.fromChat(frame, { type: 'logout' });
    assert.deepEqual(env.tokens, { a: null });
});

test('messages from other windows are ignored', async () => {
    await env.shell.handleMessage({ source: {}, data: { type: 'save-credentials', token: 'evil' } });
    assert.deepEqual(env.tokens, {});
});

test('a tapped notification of another connection opens it, then the conversation', async () => {
    await env.shell.openTarget({ profile: 'b', target: '#starchat' });
    await env.loaded();
    const frame = env.current();
    assert.equal(frame.hash, 'b');
    assert.ok(!frame.received.some(message => message.type === 'open-target'), 'waits for the chat');
    await env.fromChat(frame, { type: 'chat-app-ready' });
    assert.deepEqual(frame.received.at(-1), { type: 'open-target', target: '#starchat' });
});

test('shared content waits for the chat', async () => {
    await env.shell.shareReceived();
    const frame = env.current();
    assert.ok(!frame.received.some(message => message.type === 'share-received'));
    await env.fromChat(frame, { type: 'chat-app-ready' });
    assert.deepEqual(frame.received.at(-1), { type: 'share-received', share: { text: 'shared link' } });
});

test('back closes the drawer first, then asks the chat, then leaves', async () => {
    const frame = env.current();
    env.ui.openDrawer();
    env.shell.handleBackButton();
    assert.equal(env.ui.drawerOpen, false);

    env.shell.handleBackButton();
    assert.deepEqual(frame.received.at(-1), { type: 'back-button' });
    await env.fromChat(frame, { type: 'back-button-result', handled: false });
    assert.equal(env.calls.at(-1)[0], 'minimizeApp');
});

test('the chat opens the connections drawer and gets the settings state', async () => {
    const frame = env.current();
    await env.fromChat(frame, { type: 'show-connections' });
    assert.equal(env.ui.drawerOpen, true);
    await env.fromChat(frame, { type: 'settings-get' });
    assert.deepEqual(frame.received.at(-1), { type: 'settings-state', app: { connectionsApi: true }, connection: {} });
    env.shell.manageConnections();
    assert.deepEqual(frame.received.at(-1), { type: 'open-settings', section: 'connections' });
    assert.equal(env.ui.drawerOpen, false);
});
