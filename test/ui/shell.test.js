import { test } from 'vitest';
import assert from 'node:assert/strict';
import { shellMixin } from '../../src/ui/mixins/shell.js';
import { mobileMixin } from '../../src/ui/mixins/mobile.js';
import { connectionsMixin, connectionsModule } from '../../src/modules/connections.js';

function chatWithShell() {
    const calls = [];
    const chat = Object.assign({}, shellMixin(), {
        sidebarMode: 'channels',
        socket: { resume: () => calls.push(['resume']) },
        applyShellSettings: state => calls.push(['applyShellSettings', state]),
        applyTheme: theme => calls.push(['applyTheme', theme]),
        openSettings: section => calls.push(['openSettings', section]),
        markCurrentChannelAsRead: () => calls.push(['markCurrentChannelAsRead']),
        scrollToBottom: () => calls.push(['scrollToBottom']),
        setOwnPlaying: value => calls.push(['setOwnPlaying', value]),
        callModuleHook: (...args) => calls.push(['callModuleHook', ...args]),
    });
    return { chat, calls };
}

test('known shell messages reach their chat methods', () => {
    const { chat, calls } = chatWithShell();
    chat.handleShellMessage('settings-state', { app: { theme: 'dark' } });
    chat.handleShellMessage('set-theme', { theme: 'light' });
    chat.handleShellMessage('open-settings', { section: 'connections' });
    chat.handleShellMessage('tab-activated');
    chat.handleShellMessage('set-playing', { playing: 'Artist - Title' });
    chat.handleShellMessage('app-resumed');
    assert.deepEqual(calls, [
        ['applyShellSettings', { app: { theme: 'dark' } }],
        ['applyTheme', 'light'],
        ['openSettings', 'connections'],
        ['markCurrentChannelAsRead'],
        ['scrollToBottom'],
        ['setOwnPlaying', 'Artist - Title'],
        ['resume'],
    ]);
});

test('wrong value types are dropped instead of passed on', () => {
    const { chat, calls } = chatWithShell();
    chat.handleShellMessage('open-settings', { section: { evil: true } });
    chat.handleShellMessage('set-playing', { playing: 42 });
    chat.handleShellMessage('set-theme', { theme: 'neon' });
    assert.deepEqual(calls, [['openSettings', null], ['setOwnPlaying', '']]);
});

test('other messages go to the modules', () => {
    const { chat, calls } = chatWithShell();
    chat.handleShellMessage('connections-response', { id: 1, result: { ok: true } });
    assert.deepEqual(calls, [['callModuleHook', 'shellMessage', 'connections-response', { id: 1, result: { ok: true } }]]);
});

test('a channel from an irc:// link is shown, joined first when needed', () => {
    const { chat, calls } = chatWithShell();
    Object.assign(chat, {
        isRegistered: true,
        availableChannels: ['#known'],
        switchChannel: channel => calls.push(['switchChannel', channel]),
        joinChannel: channel => calls.push(['joinChannel', channel]),
    });
    chat.handleShellMessage('open-channel', { channel: '#Known' });
    chat.handleShellMessage('open-channel', { channel: 'new' });
    chat.handleShellMessage('open-channel', { channel: '#bad name' });
    assert.deepEqual(calls, [['switchChannel', '#known'], ['joinChannel', '#new']]);
});

test('a link that arrives while connecting waits for the registration', () => {
    const { chat, calls } = chatWithShell();
    Object.assign(chat, {
        isRegistered: false,
        availableChannels: [],
        joinChannel: channel => calls.push(['joinChannel', channel]),
    });
    chat.handleShellMessage('open-channel', { channel: '#later' });
    assert.deepEqual(calls, []);
    chat.isRegistered = true;
    chat.joinPendingShellChannel();
    chat.joinPendingShellChannel();
    assert.deepEqual(calls, [['joinChannel', '#later']]);
});

/** The chat in the mobile app: shell messages plus the drawer layout. */
function chatInMobileApp() {
    const host = [];
    const calls = [];
    const chat = Object.assign({}, shellMixin(), mobileMixin(), {
        shell: 'mobile',
        socket: { resume: () => calls.push('resume') },
        notifyHost: (type, data = {}) => host.push({ type, ...data }),
        callModuleHook: (...args) => calls.push(['callModuleHook', ...args]),
        isTargetVisible: () => false,
        saveChatState: () => calls.push('save-state'),
        receivePushSubscription: data => calls.push(['push', data]),
        openPushTarget: target => calls.push(['target', target]),
        receiveShare: share => calls.push(['share', share]),
    });
    return { chat, host, calls };
}

test('mobile app: the back button closes an open drawer and tells the app', () => {
    const { chat, host } = chatInMobileApp();
    chat.mobileSidebarOpen = true;
    chat.handleShellMessage('back-button');
    assert.equal(chat.mobileSidebarOpen, false);
    assert.deepEqual(host.at(-1), { type: 'back-button-result', handled: true });

    chat.handleShellMessage('back-button');
    assert.deepEqual(host.at(-1), { type: 'back-button-result', handled: false }, 'nothing open: the app goes to the background');
});

test('mobile app: pause and resume', () => {
    const { chat, calls } = chatInMobileApp();
    chat.handleShellMessage('app-paused');
    assert.equal(chat.appInBackground, true);
    assert.ok(calls.includes('save-state'));
    chat.handleShellMessage('app-resumed');
    assert.equal(chat.appInBackground, false);
    assert.ok(calls.includes('resume'));
});

test('mobile app: push answers, notification targets and shares reach their modules', () => {
    const { chat, calls } = chatInMobileApp();
    chat.handleShellMessage('push-subscription', { fcmToken: 't' });
    chat.handleShellMessage('open-target', { target: '#starchat' });
    chat.handleShellMessage('open-target', { target: 42 });
    chat.handleShellMessage('share-received', { share: { text: 'hi' } });
    assert.deepEqual(calls, [['push', { fcmToken: 't' }], ['target', '#starchat'], ['share', { text: 'hi' }]]);
});

test('mobile app: the connections button of the drawer hands over to the app', () => {
    const { chat, host } = chatInMobileApp();
    chat.mobileSidebarOpen = true;
    chat.showAppConnections();
    assert.equal(chat.mobileSidebarOpen, false);
    assert.deepEqual(host, [{ type: 'show-connections' }]);
});

test('the connections page works in both apps, not on the web', async () => {
    const page = connectionsMixin();
    const posted = [];
    page.notifyHost = (type, data) => posted.push({ type, ...data });
    page.shell = 'mobile';
    page.connectionsRequest('list');
    assert.equal(posted[0].type, 'connections-request');

    page.shell = null;
    assert.deepEqual(await page.connectionsRequest('list'), { ok: false, reason: 'unavailable' });

    const sections = [];
    connectionsModule.register({ registerSection: section => sections.push(section), registerSetting: () => {} });
    assert.equal(sections[0].when({ shell: 'mobile' }), true);
    assert.equal(sections[0].when({ shell: 'desktop' }), true);
    assert.equal(sections[0].when({ shell: null }), false);
});
