import { test } from 'vitest';
import assert from 'node:assert/strict';
import { shellMixin } from '../../src/ui/mixins/shell.js';

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
