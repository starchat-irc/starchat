/**
 * Managers for messages, nick lists and topics, run against a plain store.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { alpineStore, createPlainStore } from '../../src/core/store.js';
import { MESSAGE_LIMIT, MessageManager } from '../../src/core/messages.js';
import { UserManager } from '../../src/core/users.js';
import { ChannelManager } from '../../src/core/channels.js';

// Messages

test('messages get an id, a timestamp and a target type', () => {
    const store = createPlainStore();
    const messages = MessageManager(store);
    const entry = messages.add('#chan', { text: 'hi' });

    assert.equal(typeof entry.id, 'number');
    assert.equal(typeof entry._ts, 'number');
    assert.equal(store.get()['#chan'].type, 'channel');
    messages.add('bob', { text: 'dm' });
    assert.equal(store.get().bob.type, 'private');
});

test('existing ids and timestamps are kept', () => {
    const messages = MessageManager(createPlainStore());
    const entry = messages.add('#chan', { id: 'abc', _ts: 5, text: 'hi' });
    assert.equal(entry.id, 'abc');
    assert.equal(entry._ts, 5);
});

test('onAdd sees live messages, not buffered ones', () => {
    const seen = [];
    const messages = MessageManager(createPlainStore(), { onAdd: (target, entry) => seen.push([target, entry.text]) });
    messages.add('#chan', { text: 'live' });
    messages.bufferAdd('#chan', { text: 'history' });
    messages.flushBuffer('#chan');
    assert.deepEqual(seen, [['#chan', 'live']]);
});

test('the message list is capped', () => {
    const messages = MessageManager(createPlainStore());
    for (let i = 0; i < MESSAGE_LIMIT + 5; i++) messages.add('#chan', { text: String(i) });
    const content = messages.get('#chan');
    assert.equal(content.length, MESSAGE_LIMIT);
    assert.equal(content[0].text, '5');
});

test('buffered messages are merged in time order on flush', () => {
    const messages = MessageManager(createPlainStore());
    messages.add('#chan', { text: 'b', _ts: 20 });
    messages.bufferAdd('#chan', { text: 'c', _ts: 30 });
    messages.bufferAdd('#chan', { text: 'a', _ts: 10 });
    assert.equal(messages.get('#chan').length, 1, 'nothing visible before the flush');

    const flushed = messages.flushBuffer('#chan');
    assert.equal(flushed.length, 2);
    assert.deepEqual(messages.get('#chan').map((m) => m.text), ['a', 'b', 'c']);
    assert.deepEqual(messages.flushBuffer('#chan'), []);
});

test('remove drops a target and its buffer, keys and privateKeys list targets', () => {
    const messages = MessageManager(createPlainStore());
    messages.ensure('#chan');
    messages.ensure('bob');
    messages.ensure('Server');
    messages.bufferAdd('bob', { text: 'x' });

    assert.deepEqual(messages.privateKeys(), ['bob']);
    messages.remove('bob');
    assert.deepEqual(messages.keys(), ['#chan', 'Server']);
    assert.deepEqual(messages.flushBuffer('bob'), []);
    assert.deepEqual(messages.get('bob'), []);
});

// Users

test('a NAMES list is parsed with prefixes and merged', () => {
    const users = UserManager(createPlainStore());
    users.updateUserList('#chan', ['@op', '+voice', 'plain']);
    users.updateUserList('#chan', ['%op', 'new']);

    assert.deepEqual(users.get('#chan').map((u) => [u.name, u.role]), [
        ['op', '%'], ['voice', '+'], ['plain', ''], ['new', ''],
    ]);
});

test('users are sorted by role, then by name', () => {
    const users = UserManager(createPlainStore());
    users.updateUserList('#chan', ['zed', '+bob', '@carl', 'anna', '~owner']);
    assert.deepEqual(users.getSorted('#chan').map((u) => u.name), ['owner', 'carl', 'bob', 'anna', 'zed']);
    users.sort('#chan');
    assert.deepEqual(users.get('#chan').map((u) => u.name), ['owner', 'carl', 'bob', 'anna', 'zed']);
});

test('mode changes keep all prefixes and show the highest', () => {
    const users = UserManager(createPlainStore());
    users.updateUserList('#chan', ['+bob']);
    users.updateUserRole('#chan', 'bob', '@', true);
    assert.equal(users.getUser('#chan', 'bob').role, '@');

    users.updateUserRole('#chan', 'bob', '@', false);
    assert.equal(users.getUser('#chan', 'bob').role, '+');
    users.updateUserRole('#chan', 'bob', '+', false);
    assert.equal(users.getUser('#chan', 'bob').role, '');
});

test('add, rename and remove users', () => {
    const users = UserManager(createPlainStore());
    users.addUser('#a', 'bob', 'bobaccount', 'Bob B');
    users.addUser('#b', 'bob');
    users.addUser('#a', 'bob', 'other', 'Real');
    assert.equal(users.get('#a').length, 1);
    assert.equal(users.getUser('#a', 'bob').account, 'other');

    users.renameUser('bob', 'robert');
    assert.ok(users.getUser('#a', 'robert'));
    assert.ok(users.getUser('#b', 'robert'));

    users.removeUser('#a', 'robert');
    assert.deepEqual(users.get('#a'), []);
    assert.equal(users.get('#b').length, 1);
});

test('away, online, typing and metadata apply in every channel', () => {
    const users = UserManager(createPlainStore());
    users.addUser('#a', 'bob');
    users.addUser('#b', 'bob');

    users.setAway('bob', true);
    users.setOnline('bob', false);
    users.setTyping('#a', 'bob', true);
    users.setPlaying('bob', '  Chess ');
    users.setVoice('bob', ' #Lounge ');

    for (const channel of ['#a', '#b']) {
        const user = users.getUser(channel, 'bob');
        assert.equal(user.isAway, true);
        assert.equal(user.isOnline, false);
        assert.equal(user.playing, 'Chess');
        assert.equal(user.voice, '#lounge');
    }
    assert.equal(users.getUser('#a', 'bob').isTyping, true);
    assert.equal(users.getUser('#b', 'bob').isTyping, false);

    users.setPlaying('bob', 'none');
    users.setVoice('bob', 'not-a-channel');
    assert.equal(users.getUser('#a', 'bob').playing, '');
    assert.equal(users.getUser('#a', 'bob').voice, '');
});

test('changes replace the channel array so reactive lists update', () => {
    const users = UserManager(createPlainStore());
    users.addUser('#a', 'bob');
    const before = users.get('#a');
    users.setAway('bob', true);
    assert.notEqual(users.get('#a'), before);

    const unchanged = users.get('#a');
    users.setVoice('bob', '');
    assert.equal(users.get('#a'), unchanged, 'no flush when the voice channel stays the same');
});

test('clear and clearAll empty the lists', () => {
    const users = UserManager(createPlainStore());
    users.addUser('#a', 'bob');
    users.addUser('#b', 'bob');
    users.clear('#a');
    assert.deepEqual(users.get('#a'), []);
    users.clearAll();
    assert.deepEqual(users.get('#b'), []);
});

// Channels

test('topics are set, read and cleared', () => {
    const channels = ChannelManager(createPlainStore(undefined));
    assert.equal(channels.getTopic('#a'), '');
    channels.setTopic('#a', 'Welcome');
    assert.equal(channels.getTopic('#a'), 'Welcome');
    channels.clearTopic('#a');
    assert.equal(channels.getTopic('#a'), '');
});

test('the channel manager keeps topics already in the store', () => {
    const channels = ChannelManager(createPlainStore({ '#a': 'old' }));
    assert.equal(channels.getTopic('#a'), 'old');
});

// Store adapters

test('alpineStore reads and writes through Alpine.store', () => {
    const stores = {};
    const Alpine = {
        store(name, value) {
            if (value === undefined) return stores[name];
            stores[name] = value;
        },
    };
    const users = UserManager(alpineStore(Alpine, 'users'));
    users.addUser('#a', 'bob');
    assert.equal(stores.users['#a'][0].name, 'bob');
});
