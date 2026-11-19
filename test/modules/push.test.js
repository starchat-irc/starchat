/**
 * Push module (draft/webpush): browser subscription, app relay, filter, logout, tapped notifications.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
    base64UrlToBytes, bytesToBase64Url, pushModule, sameKey, webpushRegisterLine,
} from '../../src/modules/push.js';
import { settingsRegistry } from '../../src/ui/settings/registry.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json, loggedInChat, registered } from './module-harness.js';

const VAPID = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const ENDPOINT = 'https://push.example.com/send/abc';

/** Service worker and PushManager of a browser; records subscribe/unsubscribe. */
function stubBrowserPush({ permission = 'granted', existingKey = null } = {}) {
    const log = [];
    const workerMessages = [];
    const makeSubscription = (key) => ({
        options: { applicationServerKey: key },
        toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p256-key', auth: 'auth-key' } }),
        unsubscribe: async () => { log.push('unsubscribe'); },
    });
    let current = existingKey ? makeSubscription(existingKey) : null;
    const registration = {
        active: { postMessage: (message) => workerMessages.push(message) },
        pushManager: {
            getSubscription: async () => current,
            subscribe: async ({ applicationServerKey }) => {
                log.push('subscribe');
                current = makeSubscription(applicationServerKey.buffer);
                return current;
            },
        },
    };
    const listeners = {};
    vi.stubGlobal('navigator', {
        serviceWorker: {
            register: async (url) => { log.push(`register ${url}`); return registration; },
            ready: Promise.resolve(registration),
            getRegistration: async () => registration,
            addEventListener: (type, listener) => { listeners[type] = listener; },
        },
    });
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('Notification', { permission, requestPermission: async () => 'granted' });
    return { log, workerMessages, listeners };
}

async function browserChat(routes = {}, options = {}) {
    const result = await loggedInChat(routes, { modules: [pushModule], features: [], ...options });
    result.chat.pushWorker = '/push-sw.js';
    result.chat.supportsWebpush = true;
    return result;
}

beforeEach(() => {
    installBrowserStubs();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

test('VAPID keys survive the base64url round trip and are compared without padding', () => {
    const bytes = base64UrlToBytes(VAPID);
    assert.equal(bytes.length, 65);
    assert.equal(bytesToBase64Url(bytes), VAPID);
    assert.ok(sameKey(bytes.buffer, `${VAPID}=`));
    assert.ok(!sameKey(null, VAPID));
    assert.ok(!sameKey(new Uint8Array([1, 2, 3]).buffer, VAPID));
});

test('webpushRegisterLine only accepts https endpoints and plain keys', () => {
    assert.equal(webpushRegisterLine({ endpoint: ENDPOINT, p256dh: 'a-b_c', auth: 'x=' }),
        `WEBPUSH REGISTER ${ENDPOINT} p256dh=a-b_c;auth=x=`);
    assert.equal(webpushRegisterLine({ endpoint: 'http://push.example.com', p256dh: 'a', auth: 'b' }), null);
    assert.equal(webpushRegisterLine({ endpoint: `${ENDPOINT} QUIT`, p256dh: 'a', auth: 'b' }), null);
    assert.equal(webpushRegisterLine({ endpoint: ENDPOINT, p256dh: 'a;b', auth: 'b' }), null);
    assert.equal(webpushRegisterLine({ endpoint: ENDPOINT, p256dh: 'a', auth: undefined }), null);
});

test('browser push registers on any network with draft/webpush, without an API feature', async () => {
    const { log, workerMessages } = stubBrowserPush();
    const { chat, sent } = await browserChat();
    chat.channelNotifications = { '#Quiet': 'mute', '#loud': 'all' };
    chat.ignoredUsers = ['Troll'];

    chat.applyVapidKey(VAPID);
    await vi.waitFor(() => assert.ok(chat._pushRegistration));

    assert.deepEqual(log, ['register /push-sw.js', 'subscribe']);
    assert.ok(sent.includes(`WEBPUSH REGISTER ${ENDPOINT} p256dh=p256-key;auth=auth-key`));
    assert.equal(chat.pushStatus(), 'push_status_active');
    assert.equal(chat.pushActionLabel(), '');
    await vi.waitFor(() => assert.equal(workerMessages.length, 1));
    assert.deepEqual(workerMessages[0], { type: 'push-filter', muted: ['#quiet'], ignored: ['troll'] });
});

test('a subscription made for another VAPID key is replaced', async () => {
    const { log } = stubBrowserPush({ existingKey: new Uint8Array([1, 2, 3]).buffer });
    const { chat } = await browserChat();

    chat.applyVapidKey(VAPID);
    await vi.waitFor(() => assert.ok(chat._pushRegistration));
    assert.deepEqual(log, ['register /push-sw.js', 'unsubscribe', 'subscribe']);
});

test('no push without account, worker, server support or permission', async () => {
    stubBrowserPush({ permission: 'default' });
    const { chat, sent } = await browserChat();

    chat.applyVapidKey(VAPID);
    await Promise.resolve();
    assert.equal(chat._pushRegistration, null, 'permission not granted yet');
    assert.equal(chat.pushStatus(), 'push_status_inactive');
    assert.equal(chat.pushActionLabel(), 'push_enable');

    chat.pushWorker = null;
    assert.equal(chat.pushStatus(), 'push_status_unsupported_device');
    chat.pushWorker = '/push-sw.js';

    chat.supportsWebpush = false;
    assert.equal(chat.pushStatus(), 'push_status_unsupported_server');
    assert.ok(!sent.some(line => line.startsWith('WEBPUSH')));

    const guest = chatWith(connectionWith(apiStub({}), { features: [] }), { modules: [pushModule] }).chat;
    guest.pushWorker = '/push-sw.js';
    guest.supportsWebpush = true;
    guest.webpushVapidKey = VAPID;
    assert.ok(!guest.canUsePush());
    assert.equal(guest.pushStatus(), 'push_status_account_only');
});

test('a denied permission shows up in the status and hides the button', async () => {
    stubBrowserPush({ permission: 'denied' });
    const { chat } = await browserChat();
    chat.webpushVapidKey = VAPID;
    assert.equal(chat.pushStatus(), 'push_status_denied_browser');
    assert.equal(chat.pushActionLabel(), '');
});

test('the desktop shell has no push and does not show the setting', () => {
    const { chat } = chatWith(connectionWith(apiStub({}), { features: ['push'] }), { modules: [pushModule] });
    chat.shell = 'desktop';
    assert.equal(chat.pushPlatform(), null);

    pushModule.register(settingsRegistry);
    const setting = settingsRegistry.settingsFor('notifications', { shell: 'desktop', hasFeature: () => true })
        .find(entry => entry.id === 'notifications.push');
    assert.equal(setting, undefined);
    const browserSetting = settingsRegistry.settingsFor('notifications', { shell: null, hasFeature: () => false })
        .find(entry => entry.id === 'notifications.push');
    assert.ok(browserSetting);
});

test('the app hands over its FCM token, the API returns the relay endpoint', async () => {
    const { chat, sent, fetch } = await loggedInChat({
        'POST chat/push-devices': json({ endpoint: 'https://home.example.org/api/push/relay-1' }, 201),
        'DELETE chat/push-devices': json({}, 204),
    }, { modules: [pushModule], features: ['push'] });
    const host = [];
    chat.notifyHost = (type, data) => host.push({ type, data });
    chat.shell = 'mobile';
    chat.supportsWebpush = true;

    chat.applyVapidKey(VAPID);
    assert.equal(host[0].type, 'push-subscribe');
    chat.receivePushSubscription({ fcmToken: 'fcm-1', p256dh: 'p256-app', auth: 'auth-app' });
    await vi.waitFor(() => assert.ok(chat._pushRegistration));

    const post = fetch.calls.find(call => call.path === 'chat/push-devices');
    assert.equal(post.init.method, 'POST');
    assert.equal(post.init.headers.get('Authorization'), 'Bearer jwt-1');
    assert.deepEqual(JSON.parse(post.init.body), { fcm_token: 'fcm-1' });
    assert.ok(sent.includes('WEBPUSH REGISTER https://home.example.org/api/push/relay-1 p256dh=p256-app;auth=auth-app'));
    assert.ok(host.some(message => message.type === 'push-filter'));

    chat.logout();
    assert.ok(sent.includes('WEBPUSH UNREGISTER https://home.example.org/api/push/relay-1'), 'sent before the socket closed');
    const remove = fetch.calls.find(call => call.init.method === 'DELETE');
    assert.deepEqual(JSON.parse(remove.init.body), { fcm_token: 'fcm-1' });
    assert.ok(host.some(message => message.type === 'push-unsubscribe'));
    assert.equal(chat._pushRegistration, null);
});

test('the app needs the network relay (feature push)', async () => {
    const { chat } = await loggedInChat({}, { modules: [pushModule], features: [] });
    chat.shell = 'mobile';
    chat.supportsWebpush = true;
    chat.webpushVapidKey = VAPID;
    assert.ok(!chat.canUsePush());
    assert.equal(chat.pushStatus(), 'push_status_unsupported_server');
});

test('an app error ends up in the status', async () => {
    const { chat } = await loggedInChat({}, { modules: [pushModule], features: ['push'] });
    chat.notifyHost = () => {};
    chat.shell = 'mobile';
    chat.supportsWebpush = true;

    chat.applyVapidKey(VAPID);
    chat.receivePushSubscription({ error: 'permission denied' });
    await vi.waitFor(() => assert.equal(chat.pushError, 'denied'));
    assert.equal(chat.pushStatus(), 'push_status_denied_app');
});

test('logout in the browser unregisters and drops the subscription', async () => {
    const { log } = stubBrowserPush();
    const { chat, sent } = await browserChat();
    chat.applyVapidKey(VAPID);
    await vi.waitFor(() => assert.ok(chat._pushRegistration));

    chat.logout();
    assert.ok(sent.includes(`WEBPUSH UNREGISTER ${ENDPOINT}`));
    await vi.waitFor(() => assert.ok(log.includes('unsubscribe')));
});

test('a tapped notification waits for the joins, then opens the conversation', () => {
    const { chat } = chatWith(connectionWith(apiStub({}), { features: [] }), { modules: [pushModule] });
    const opened = [];
    chat.switchChannel = (channel) => opened.push(['channel', channel]);
    chat.sendPrivateMessage = (nick) => opened.push(['query', nick]);

    chat.openPushTarget('#Bridge');
    assert.equal(chat._pendingPushTarget, '#Bridge', 'not registered yet');

    registered(chat);
    chat.availableChannels = ['#bridge'];
    assert.ok(chat.applyPendingPushTarget());
    assert.deepEqual(opened, [['channel', '#bridge']]);

    chat.openPushTarget('alice');
    chat.openPushTarget('#notjoined');
    assert.deepEqual(opened, [['channel', '#bridge'], ['query', 'alice']]);
    assert.ok(!chat.applyPendingPushTarget());
});

test('init picks up ?open= and listens to the service worker', () => {
    const { listeners } = stubBrowserPush();
    vi.stubGlobal('location', { href: 'https://chat.example.org/?open=%23bridge' });
    const { chat } = chatWith(connectionWith(apiStub({}), { features: [] }), { modules: [pushModule] });
    pushModule.hooks.init.call(chat);
    assert.equal(chat._pendingPushTarget, '#bridge');

    const targets = [];
    chat.openPushTarget = (target) => targets.push(target);
    listeners.message({ data: { type: 'open-target', target: 'bob' } });
    listeners.message({ data: { type: 'other' } });
    assert.deepEqual(targets, ['bob']);
});
