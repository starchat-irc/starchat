/**
 * Chat state module: restore and save of the session, synced preferences.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { chatStateModule } from '../../src/modules/chat-state.js';
import { alwaysOnModule } from '../../src/modules/always-on.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { json, loggedInChat as baseLoggedInChat } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

afterEach(() => {
    vi.useRealTimers();
});

const STATE = {
    open_dms: ['bob'],
    joined_channels: ['#Bridge', '#lobby', 'nochannel'],
    active_channel: '#bridge',
    sidebar_mode: 'channels',
    last_read: { bob: '2026-11-19T10:00:00.000Z' },
    unread_counts: { '#bridge': 3, bob: 2 },
    settings: { highlight_words: ['warp'], quit_message: 'Bye', autojoin_channels: ['#news'] },
};

function loggedInChat(routes = {}, options = {}) {
    return baseLoggedInChat({ 'GET chat-state': json(STATE), ...routes }, {
        modules: [chatStateModule],
        features: ['chatState'],
        ...options,
    });
}

/** Login without registration: the state arrives before 001. */
async function connectedChat(routes, options) {
    const result = await loggedInChat(routes, options);
    result.chat.isRegistered = false;
    result.chat.lobbyChannel = '#lobby';
    result.chat.availableChannels = ['#lobby'];
    result.chat.currentChannel = '#lobby';
    result.chat._chatStateInitialized = false;
    return result;
}

test('the saved session is restored before registration', async () => {
    const { chat } = await connectedChat();
    await chat.restoreChatState();

    assert.ok(chat._chatStateInitialized);
    assert.deepEqual(chat.availableChannels, ['#lobby', '#bridge'], 'joined with the connect, lobby and junk dropped');
    assert.ok(chat.privateMessageKeys.includes('bob'));
    assert.equal(chat.unreadMessages.bob, 2);
    assert.equal(chat._lastRead.bob, '2026-11-19T10:00:00.000Z');
    assert.equal(chat.currentChannel, '#bridge', 'the last active channel is shown again');
    assert.deepEqual(chat.highlightWords, ['warp']);
    assert.equal(chat.quitMessage, 'Bye');
    assert.deepEqual(chat.autojoinChannels, ['#news']);
    assert.ok(!chat.hasChangedAccountSettings(), 'restored values are not sent back');
});

test('a channel the page asked for stays shown instead of the last active one', async () => {
    const { chat } = await connectedChat();
    chat.requestedChannels = ['#lobby'];
    await chat.restoreChatState();

    assert.deepEqual(chat.availableChannels, ['#lobby', '#bridge'], 'the other channels of the session are still joined');
    assert.equal(chat.currentChannel, '#lobby');
});

test('after registration the channels are joined right away', async () => {
    const { chat, sent } = await connectedChat();
    chat.isRegistered = true;
    chat.socket = { send: (line) => sent.push(line) };
    await chat.restoreChatState();
    assert.ok(sent.some(line => /^JOIN .*#bridge/.test(line)));
});

test('nothing is restored or saved without the feature or a token', async () => {
    const { chat, fetch } = await connectedChat({}, { features: [] });
    await chat.restoreChatState();
    assert.ok(!chat.syncsWithAccount());
    assert.ok(!fetch.calls.some(call => call.path === 'chat-state'));

    chat.hasApiToken = false;
    await chat.saveChatState();
    assert.ok(!fetch.calls.some(call => call.path === 'chat-state'));
});

test('a save sends the session and only the preferences changed here', async () => {
    let body = null;
    const { chat } = await connectedChat({ 'POST chat-state': (init) => { body = JSON.parse(init.body); return json({}); } });
    await chat.restoreChatState();
    chat.availableChannels = ['#lobby', '#bridge'];
    chat.unreadMessages = { '#bridge': 2, '#lobby': 0 };

    chat.setIgnoredUsers(['troll']);
    assert.ok(chat.hasChangedAccountSettings());
    await chat.saveChatState();

    assert.deepEqual(body.joined_channels, ['#bridge']);
    assert.deepEqual(body.open_dms, ['bob']);
    assert.deepEqual(body.unread_counts, { '#bridge': 2 });
    assert.deepEqual(body.settings_patch, { ignored_users: ['troll'] });
    assert.ok(!chat.hasChangedAccountSettings(), 'confirmed by the server');
});

test('changes are saved together after a delay', async () => {
    vi.useFakeTimers();
    const { chat, fetch } = await connectedChat({ 'POST chat-state': json({}) });
    await chat.restoreChatState();
    chat.scheduleChatStateSave();
    chat.scheduleChatStateSave();
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(fetch.calls.filter(call => call.method === 'POST' && call.path === 'chat-state').length, 1);
});

test('a failed save keeps the changes for the next one', async () => {
    const { chat } = await connectedChat({ 'POST chat-state': json({}, 500) });
    await chat.restoreChatState();
    chat.setHighlightWords(['phaser']);
    await chat.saveChatState();
    assert.ok(chat.hasChangedAccountSettings());
});

test('an account without settings takes the values of this device', async () => {
    const { chat } = await connectedChat({ 'GET chat-state': json({ ...STATE, settings: null }) });
    chat.setHighlightWords(['local'], { sync: false });
    await chat.restoreChatState();
    assert.deepEqual(chat.highlightWords, ['local']);
    assert.deepEqual(chat.buildAccountSettingsPatch().patch, { highlight_words: ['local'] });
});

test('unsaved changes of this device win over the account', async () => {
    const { chat } = await connectedChat();
    chat.setHighlightWords(['mine']);
    await chat.restoreChatState();
    assert.deepEqual(chat.highlightWords, ['mine']);
    assert.equal(chat.quitMessage, 'Bye', 'other settings still come from the account');
});

test('the lobby waits for the left-lobby list and is settled afterwards', async () => {
    const { chat } = await connectedChat({ 'GET chat-state': new TypeError('offline') });
    assert.ok(chat.syncsWithAccount());
    await chat.restoreChatState();
    assert.ok(chat._lobbySettled, 'settled even when the API is down');
    assert.ok(!chat._chatStateInitialized);
});

test('logout forgets the state', async () => {
    const { chat } = await connectedChat();
    await chat.restoreChatState();
    chat.callModuleHook('loggedOut');
    assert.ok(!chat._chatStateInitialized);
    assert.deepEqual(chat._lastRead, {});
});

// Always-on

function alwaysOnChat(routes) {
    return baseLoggedInChat(routes, { modules: [alwaysOnModule], features: ['alwaysOn'] });
}

test('always-on asks once after the first registration', async () => {
    const { chat, fetch } = await alwaysOnChat({ 'GET chat/always-on': json({ enabled: false, ask: true }) });
    await chat.checkAlwaysOnPrompt();
    await chat.checkAlwaysOnPrompt();
    assert.ok(chat.alwaysOn.showPrompt);
    assert.equal(fetch.calls.filter(call => call.path === 'chat/always-on').length, 1);
});

test('accepting turns it on, declining is stored on the server', async () => {
    const { chat, fetch } = await alwaysOnChat({
        'PUT chat/always-on': (init) => json({ enabled: JSON.parse(init.body).enabled, ask: false }),
        'POST chat/always-on/dismiss': json({ ask: false }),
    });
    chat.alwaysOn.showPrompt = true;
    await chat.acceptAlwaysOnPrompt();
    assert.ok(chat.alwaysOn.enabled);
    assert.ok(!chat.alwaysOn.showPrompt);
    assert.equal(chat.alwaysOn.notice, chat.t('always_on_enabled'));

    chat.alwaysOn.showPrompt = true;
    await chat.declineAlwaysOnPrompt();
    assert.ok(!chat.alwaysOn.showPrompt);
    assert.ok(fetch.calls.some(call => call.method === 'POST' && call.path === 'chat/always-on/dismiss'));
});

test('a refused switch goes back and shows our own text', async () => {
    const { chat } = await alwaysOnChat({ 'PUT chat/always-on': json({ message: 'Nicht verfügbar' }, 503) });
    const event = { target: { checked: true } };
    await chat.toggleAlwaysOn(event);
    assert.equal(event.target.checked, false);
    assert.equal(chat.alwaysOn.error, chat.t('always_on_unavailable'));
});

test('the account section loads the state, guests are never asked', async () => {
    const { chat } = await alwaysOnChat({ 'GET chat/always-on': json({ enabled: true, ask: false }) });
    chat.callModuleHook('settingsSectionOpened', 'account');
    await vi.waitFor(() => assert.ok(chat.alwaysOn.loaded));
    assert.ok(chat.alwaysOn.enabled);

    chat.hasApiToken = false;
    chat._alwaysOnChecked = false;
    assert.equal(await chat.checkAlwaysOnPrompt(), undefined);
    assert.ok(!chat._alwaysOnChecked);
});
