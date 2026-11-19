import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import commands, { registerCommand } from '../../src/core/commands.js';
import { isServiceNick } from '../../src/core/services.js';

let ctx;

beforeEach(() => {
    const openWindows = ['#chan', 'Bob'];
    ctx = {
        nickname: 'alice',
        currentChannel: '#chan',
        ignoredUsers: [],
        highlightWords: [],
        chatTarget: true,
        isChatTarget() { return this.chatTarget; },
        t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
        messageManager: { keys: () => openWindows },
        hasOpenQuery: () => false,
        activeUsers: { setAway: vi.fn() },
        joinChannel: vi.fn(),
        partChannel: vi.fn(),
        sendRaw: vi.fn(),
        sendOwnMessage: vi.fn(),
        sendServerCommand: vi.fn(),
        sendServiceCommand: vi.fn(),
        sendCtcpRequest: vi.fn(),
        switchChannel: vi.fn(),
        scrollToBottom: vi.fn(),
        updateStatus: vi.fn(),
        addToServerWindow: vi.fn(),
        requestChannelList: vi.fn(),
        openServerWindow: vi.fn(),
        ignoreUser: vi.fn(() => true),
        unignoreUser: vi.fn(() => true),
        addHighlightWords: vi.fn(),
        removeHighlightWord: vi.fn(),
        setHighlightWords: vi.fn(),
    };
});

test('join adds the # and lower-cases each channel', () => {
    commands.join(['Lobby, #Help'], ctx);
    assert.deepEqual(ctx.joinChannel.mock.calls, [['#lobby'], ['#help']]);
});

test('join without a channel does nothing', () => {
    commands.join([], ctx);
    assert.equal(ctx.joinChannel.mock.calls.length, 0);
});

test('msg reuses an open DM window regardless of case', () => {
    commands.msg(['bob', 'hello', 'there'], ctx);
    assert.deepEqual(ctx.sendOwnMessage.mock.calls[0], ['Bob', 'hello there']);
    assert.deepEqual(ctx.switchChannel.mock.calls[0], ['Bob']);
});

test('msg to a service goes to the server window', () => {
    commands.msg(['NickServ', 'IDENTIFY', 'secret'], ctx);
    assert.deepEqual(ctx.sendServiceCommand.mock.calls[0], ['NickServ', 'IDENTIFY secret']);
    assert.equal(ctx.sendOwnMessage.mock.calls.length, 0);
});

test('msg to a service with an open query stays in the query', () => {
    ctx.hasOpenQuery = () => true;
    commands.msg(['NickServ', 'help'], ctx);
    assert.deepEqual(ctx.sendOwnMessage.mock.calls[0], ['NickServ', 'help']);
});

test('msg without text does nothing', () => {
    commands.msg(['bob'], ctx);
    commands.msg([], ctx);
    assert.equal(ctx.sendOwnMessage.mock.calls.length, 0);
});

test('me sends an action in the current channel', () => {
    commands.me(['waves'], ctx);
    assert.deepEqual(ctx.sendOwnMessage.mock.calls[0], ['#chan', 'waves', { isAction: true }]);
});

test('me in the server window shows an error instead', () => {
    ctx.chatTarget = false;
    commands.me(['waves'], ctx);
    assert.equal(ctx.sendOwnMessage.mock.calls.length, 0);
    assert.deepEqual(ctx.addToServerWindow.mock.calls[0], ['server_chat_only', { kind: 'error' }]);
});

test('nick, away and back send the raw commands', () => {
    commands.nick(['bob2'], ctx);
    commands.away(['lunch', 'break'], ctx);
    commands.back([], ctx);
    assert.deepEqual(ctx.sendRaw.mock.calls, [['NICK bob2'], ['AWAY :lunch break'], ['AWAY']]);
    assert.deepEqual(ctx.activeUsers.setAway.mock.calls, [['alice', true], ['alice', false]]);
});

test('whois asks the user\'s own server', () => {
    commands.whois(['bob'], ctx);
    assert.deepEqual(ctx.sendServerCommand.mock.calls[0], ['WHOIS bob bob']);
});

test('service shortcuts address the service', () => {
    commands.cs(['OP', '#chan'], ctx);
    assert.deepEqual(ctx.sendServiceCommand.mock.calls[0], ['ChanServ', 'OP #chan']);
});

test('ctcp needs a target and a command', () => {
    commands.ctcp(['bob'], ctx);
    assert.equal(ctx.sendCtcpRequest.mock.calls.length, 0);
    assert.equal(ctx.addToServerWindow.mock.calls.length, 1);

    commands.ctcp(['bob', 'PING', '123'], ctx);
    assert.deepEqual(ctx.sendCtcpRequest.mock.calls[0], ['bob', 'PING', '123']);
});

test('version without a nick asks the server', () => {
    commands.version([], ctx);
    commands.version(['bob'], ctx);
    assert.deepEqual(ctx.sendServerCommand.mock.calls[0], ['VERSION']);
    assert.deepEqual(ctx.sendCtcpRequest.mock.calls[0], ['bob', 'VERSION']);
});

test('highlight add, del, clear and usage', () => {
    commands.highlight(['add', 'Warp', '9,', 'Kirk'], ctx);
    assert.deepEqual(ctx.addHighlightWords.mock.calls[0], ['Warp 9, Kirk']);
    commands.highlight(['del', 'Kirk'], ctx);
    assert.deepEqual(ctx.removeHighlightWord.mock.calls[0], ['Kirk']);
    commands.highlight(['clear'], ctx);
    assert.deepEqual(ctx.setHighlightWords.mock.calls[0], [[]]);

    ctx.updateStatus.mockClear();
    commands.highlight(['bogus'], ctx);
    assert.deepEqual(ctx.updateStatus.mock.calls, [['highlight_usage']]);
});

test('roll and flip send an action', () => {
    commands.roll([], ctx);
    commands.flip([], ctx);
    assert.match(ctx.sendOwnMessage.mock.calls[0][1], /^alice rolls a d20: ([1-9]|1\d|20)$/);
    assert.match(ctx.sendOwnMessage.mock.calls[1][1], /^alice flips a coin: (Heads|Tails)$/);
});

test('registerCommand adds a command', () => {
    registerCommand('Hello', (args, context) => context.sendRaw(`HELLO ${args[0]}`));
    commands.hello(['world'], ctx);
    assert.deepEqual(ctx.sendRaw.mock.calls[0], ['HELLO world']);
});

test('isServiceNick knows the common services, case-insensitive', () => {
    assert.equal(isServiceNick('NickServ'), true);
    assert.equal(isServiceNick('alis'), true);
    assert.equal(isServiceNick('bob'), false);
    assert.equal(isServiceNick(undefined), false);
});
