/**
 * Incoming IRC lines processed by the chat mixins, without feature modules.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createTestChat, installBrowserStubs } from './chat-harness.js';
import { SERVER_WINDOW } from '../../src/ui/mixins/server-window.js';

beforeEach(() => {
    installBrowserStubs();
});

/** A chat that is registered and sits in #chan. */
function joinedChat(options = {}) {
    const harness = createTestChat(options);
    harness.receive(':irc.test 001 me :Welcome');
    harness.receive(':me!u@h JOIN #chan');
    harness.chat.switchChannel('#chan');
    harness.sent.length = 0;
    return harness;
}

// Registration

test('001 registers, joins the last channels in one line and tells the host the nick', () => {
    const { chat, sent, hostMessages, receive } = createTestChat({ state: { availableChannels: ['#a', '#b'] } });
    receive(':irc.test 001 me_ :Welcome');

    assert.equal(chat.nickname, 'me_');
    assert.equal(chat.isRegistered, true);
    assert.equal(chat.connectionState, 'connected');
    assert.ok(sent.includes('JOIN #a,#b'));
    assert.deepEqual(hostMessages, [{ type: 'update-profile-name', nickname: 'me_' }]);
});

test('without feature modules only plain metadata keys are subscribed', () => {
    const { sent, receive } = createTestChat({ state: { supportsMetadata: true } });
    receive(':irc.test 001 me :Welcome');
    assert.ok(sent.includes('METADATA * SUB playing status'));
});

test('servers with profiles and voice also get avatars and voice markers', () => {
    const { sent, receive } = createTestChat({ features: ['profiles', 'voice'], state: { supportsMetadata: true } });
    receive(':irc.test 001 me :Welcome');
    assert.ok(sent.includes('METADATA * SUB playing status avatar voice'));
});

test('PING is answered', () => {
    const { sent, receive } = createTestChat();
    receive('PING :abc');
    assert.deepEqual(sent, ['PONG :abc']);
});

test('a taken nick is retried with a suffix', () => {
    const { chat, sent, receive } = createTestChat();
    receive(':irc.test 433 * me :Nickname is already in use');
    receive(':irc.test 433 * me_ :Nickname is already in use');
    assert.deepEqual(sent, ['NICK me_', 'NICK me2']);
    assert.match(chat.connectionStatus, /me_ is in use, trying me2/);
});

// Channels

test('the own JOIN adds the channel and asks for its history', () => {
    const { chat, sent, receive } = createTestChat({ state: { supportsChathistory: true } });
    receive(':irc.test 001 me :Welcome');
    receive(':me!u@h JOIN #New');

    assert.deepEqual(chat.availableChannels, ['#new']);
    assert.ok(sent.includes('CHATHISTORY LATEST #new * 50'));
});

test('JOIN of someone else adds a status line and the user', () => {
    const { chat, receive } = joinedChat();
    receive(':bob!u@h JOIN #chan bobaccount :Bob Real');

    const last = chat.messageManager.get('#chan').at(-1);
    assert.equal(last.text, 'bob (bobaccount) has joined the channel');
    assert.equal(last.joinPartType, 'join');
    assert.equal(chat.activeUsers.getUser('#chan', 'bob').account, 'bobaccount');
});

test('being kicked removes the channel and leaves it', () => {
    const { chat, receive } = joinedChat();
    receive(':me!u@h JOIN #other');
    chat.switchChannel('#chan');
    receive(':op!u@h KICK #chan me :bye');

    assert.deepEqual(chat.availableChannels, ['#other']);
    assert.equal(chat.currentChannel, '#other');
});

test('a PART from another session of the account removes the channel here too', () => {
    const { chat, receive } = joinedChat();
    receive(':me!u@h JOIN #other');
    receive(':me!u@h PART #other');
    assert.deepEqual(chat.availableChannels, ['#chan']);
});

test('topics are stored lower-cased by channel', () => {
    const { chat, receive } = joinedChat();
    receive(':irc.test 332 me #Chan :Hello there');
    assert.equal(chat.channelManager.getTopic('#chan'), 'Hello there');
    receive(':op!u@h TOPIC #chan :New topic');
    assert.equal(chat.channelManager.getTopic('#chan'), 'New topic');
});

test('MODE updates the prefix of a user', () => {
    const { chat, receive } = joinedChat();
    receive(':bob!u@h JOIN #chan');
    receive(':op!u@h MODE #chan +o bob');
    assert.equal(chat.activeUsers.getUser('#chan', 'bob').role, '@');
});

test('mode replies fill the channel management store', () => {
    const { chat, stores, receive } = joinedChat();
    receive(':irc.test 324 me #chan +nt');
    receive(':irc.test 367 me #chan *!*@bad.host op 1700000000');

    assert.equal(stores.channelManagement.get().standardModeState.n, true);
    assert.equal(stores.channelManagement.get().standardModeState.m, false);
    assert.deepEqual(stores.channelManagement.get().banList.map(entry => entry.mask), ['*!*@bad.host']);
    assert.equal(chat.channelManagementStore().channelModesDraft, '+nt');
});

// Messages

test('channel messages are stored with sender, msgid and server time', () => {
    const { chat, receive } = joinedChat();
    receive('@msgid=m1;time=2026-11-19T10:00:00.000Z :bob!u@h PRIVMSG #chan :hello');

    const message = chat.messageManager.get('#chan').at(-1);
    assert.equal(message.user, 'bob');
    assert.equal(message.text, 'hello');
    assert.equal(message.msgid, 'm1');
    assert.equal(message._ts, Date.parse('2026-11-19T10:00:00.000Z'));
});

test('messages in a hidden channel count as unread, mentions separately', () => {
    const { chat, receive } = joinedChat();
    receive(':me!u@h JOIN #other');
    chat.switchChannel('#chan');
    receive(':bob!u@h PRIVMSG #other :hi all');
    receive(':bob!u@h PRIVMSG #other :hi me');

    assert.equal(chat.unreadMessages['#other'], 2);
    assert.equal(chat.mentionsByChannel['#other'], 1);
    assert.equal(chat.mentionCount, 1);
});

test('the same msgid is shown once', () => {
    const { chat, receive } = joinedChat();
    receive('@msgid=dup :bob!u@h PRIVMSG #chan :once');
    receive('@msgid=dup :bob!u@h PRIVMSG #chan :once');
    assert.equal(chat.messageManager.get('#chan').filter(message => message.msgid === 'dup').length, 1);
});

test('a private message opens a window named after the sender and notifies the host', () => {
    const { chat, hostMessages, receive } = joinedChat();
    receive(':Bob!u@h PRIVMSG me :psst');

    assert.deepEqual(chat.privateMessageKeys, ['Bob']);
    assert.equal(chat.messageManager.get('Bob')[0].text, 'psst');
    assert.deepEqual(hostMessages.at(-1), { type: 'incoming-message', sender: 'Bob', channel: 'Bob', text: 'psst', isDm: true, isMention: false });
});

test('service replies go to the server window, not to a DM', () => {
    const { chat, receive } = joinedChat();
    receive(':NickServ!s@services NOTICE me :You are now identified');

    assert.deepEqual(chat.privateMessageKeys, []);
    assert.equal(chat.messageManager.get(SERVER_WINDOW).at(-1).text, 'You are now identified');
});

test('messages of ignored users are dropped', () => {
    const { chat, receive } = joinedChat();
    chat.ignoreUser('Troll');
    receive(':troll!u@h PRIVMSG #chan :spam');
    assert.equal(chat.messageManager.get('#chan').some(message => message.text === 'spam'), false);
});

test('CTCP VERSION is answered with the client version', () => {
    const { sent, receive } = joinedChat();
    receive(':bob!u@h PRIVMSG me :\u0001VERSION\u0001');
    assert.deepEqual(sent, ['NOTICE bob :\u0001VERSION StarChat test\u0001']);
});

test('ACTION becomes an action message', () => {
    const { chat, receive } = joinedChat();
    receive(':bob!u@h PRIVMSG #chan :\u0001ACTION waves\u0001');
    const message = chat.messageManager.get('#chan').at(-1);
    assert.equal(message.isAction, true);
    assert.equal(message.text, 'waves');
});

test('the echo of an own message gives the local copy its msgid', () => {
    const { chat, receive } = joinedChat();
    const local = chat.messageManager.add('#chan', { user: 'me', text: 'mine', pending: true });
    chat.expectEcho('#chan', ['mine'], local);
    receive('@msgid=own1 :me!u@h PRIVMSG #chan :mine');

    const mine = chat.messageManager.get('#chan').filter(message => message.text === 'mine');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].msgid, 'own1');
    assert.equal(mine[0].pending, false);
});

test('a multiline batch becomes one message', () => {
    const { chat, receive } = joinedChat();
    receive('@msgid=ml1 :bob!u@h BATCH +b1 draft/multiline #chan');
    receive('@batch=b1 :bob!u@h PRIVMSG #chan :first line');
    receive('@batch=b1 :bob!u@h PRIVMSG #chan :second');
    receive('@batch=b1;draft/multiline-concat :bob!u@h PRIVMSG #chan : half');
    receive(':bob!u@h BATCH -b1');

    const message = chat.messageManager.get('#chan').at(-1);
    assert.equal(message.text, 'first line\nsecond half');
    assert.equal(message.msgid, 'ml1');
});

test('a chathistory batch is inserted in time order when it ends', () => {
    const { chat, receive } = joinedChat();
    receive(':irc.test BATCH +h1 chathistory #chan');
    receive('@batch=h1;msgid=h-b;time=2026-11-19T09:00:02.000Z :bob!u@h PRIVMSG #chan :second');
    receive('@batch=h1;msgid=h-a;time=2026-11-19T09:00:01.000Z :bob!u@h PRIVMSG #chan :first');
    assert.equal(chat.messageManager.get('#chan').some(message => message.isHistorical), false);
    receive(':irc.test BATCH -h1');

    const texts = chat.messageManager.get('#chan').filter(message => message.isHistorical).map(message => message.text);
    assert.deepEqual(texts, ['first', 'second']);
    assert.equal(chat.historyCursorByTarget['#chan'], '2026-11-19T09:00:01.000Z');
});

test('reactions attach to the message they refer to', () => {
    const { chat, receive } = joinedChat();
    receive('@msgid=r1 :bob!u@h PRIVMSG #chan :react to me');
    receive('@+draft/reply=r1;+draft/react=👍 :alice!u@h TAGMSG #chan');

    const message = chat.findMessageByMsgid('#chan', 'r1');
    assert.deepEqual(message.reactions, [{ emoji: '👍', nicks: ['alice'] }]);
});

test('REDACT marks the message as deleted', () => {
    const { chat, receive } = joinedChat();
    receive('@msgid=x1 :bob!u@h PRIVMSG #chan :oops');
    receive(':bob!u@h REDACT #chan x1');
    assert.equal(chat.findMessageByMsgid('#chan', 'x1').redacted, true);
});

// Nicks and metadata

test('the own NICK change updates the nick and tells the host', () => {
    const { chat, hostMessages, receive } = joinedChat();
    receive(':me!u@h NICK newme');
    assert.equal(chat.nickname, 'newme');
    assert.deepEqual(hostMessages.at(-1), { type: 'update-profile-name', nickname: 'newme' });
});

test('now-playing from metadata is set on the user', () => {
    const { chat, receive } = joinedChat({ state: { supportsMetadata: true } });
    receive(':bob!u@h JOIN #chan');
    receive(':irc.test 761 me bob playing * :Some Song');
    assert.equal(chat.activeUsers.getUser('#chan', 'bob').playing, 'Some Song');
    receive(':irc.test 766 me bob playing :Key not set');
    assert.equal(chat.activeUsers.getUser('#chan', 'bob').playing, '');
});

test('bots are marked from the bot tag', () => {
    const { chat, receive } = joinedChat();
    receive('@bot :helper!u@h PRIVMSG #chan :beep');
    assert.equal(chat.isBotNick('helper'), true);
    assert.equal(chat.isBotNick('ChanServ'), true);
    assert.equal(chat.isBotNick('bob'), false);
});

test('server numerics are logged in the server window, noisy ones are not', () => {
    const { chat, receive } = joinedChat();
    chat.clearServerWindow();
    receive(':irc.test 353 me = #chan :me bob');
    receive(':irc.test 311 me bob u host * :Bob Real');

    const lines = chat.messageManager.get(SERVER_WINDOW).map(message => message.text);
    assert.deepEqual(lines, ['bob is u@host – Bob Real']);
});
