/**
 * Connection preferences and drafts, stored per storage scope.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createTestChat, installBrowserStubs } from './chat-harness.js';
import { DEFAULT_QUIT_MESSAGE } from '../../src/core/websocket.js';
import { preferencesMixin } from '../../src/ui/mixins/preferences.js';

let storage;

beforeEach(() => {
    storage = installBrowserStubs();
});

test('preferences of two connections do not mix', () => {
    const first = createTestChat({ storageScope: 'irc.example.org' }).chat;
    first.ignoreUser('troll');
    first.setChannelNotifyLevel('#Busy', 'mute');

    const second = createTestChat({ storageScope: 'other.example.net' }).chat;
    assert.deepEqual(second.ignoredUsers, []);
    assert.equal(second.channelNotifyLevel('#busy'), 'all');

    const firstAgain = createTestChat({ storageScope: 'irc.example.org' }).chat;
    assert.deepEqual(firstAgain.ignoredUsers, ['troll']);
    assert.equal(firstAgain.channelNotifyLevel('#busy'), 'mute');
    assert.ok(storage.has('chat.ignoredUsers:irc.example.org'));
});

test('changes are reported to an account sync module when one is loaded', () => {
    const changed = [];
    const { chat } = createTestChat({ state: { markAccountSettingChanged: (key) => changed.push(key) } });
    chat.addHighlightWords('pizza');
    chat.setNickColor('bob', 140);
    chat.setNickColor('bob', 140, { sync: false });
    assert.deepEqual(changed, ['highlight_words', 'nick_colors']);
});

test('the quit message falls back to the app default, then to the built-in one', () => {
    assert.equal(Object.assign({}, preferencesMixin()).effectiveQuitMessage(), DEFAULT_QUIT_MESSAGE);

    const chat = Object.assign({}, preferencesMixin({ defaultQuitMessage: 'Bye from the app' }));
    assert.equal(chat.effectiveQuitMessage(), 'Bye from the app');
    chat.setQuitMessage('see you\nlater');
    assert.equal(chat.effectiveQuitMessage(), 'see you later');
});

test('another tab of the same connection updates the list', () => {
    const { chat } = createTestChat({ storageScope: 'irc.example.org' });
    storage.set('chat.highlightWords:irc.example.org', JSON.stringify(['cake']));
    chat.handlePreferenceStorageEvent({ key: 'chat.highlightWords:irc.example.org' });
    assert.deepEqual(chat.highlightWords, ['cake']);

    chat.handlePreferenceStorageEvent({ key: 'chat.highlightWords:other.example.net' });
    assert.deepEqual(chat.highlightWords, ['cake']);
});

test('drafts survive a channel switch and a restart', () => {
    const { chat, receive } = createTestChat({ storageScope: 'irc.example.org' });
    receive(':irc.test 001 me :Welcome');
    receive(':me!u@h JOIN #a');
    receive(':me!u@h JOIN #b');
    chat.switchChannel('#a');
    chat.newMessage = 'half written';
    chat.switchChannel('#b');
    assert.equal(chat.newMessage, '');
    chat.switchChannel('#a');
    assert.equal(chat.newMessage, 'half written');

    const restarted = createTestChat({ storageScope: 'irc.example.org' }).chat;
    assert.equal(restarted.channelDrafts['#a'], 'half written');
});

test('a lobby the user left is not joined on the next connect', () => {
    const { chat, sent, receive } = createTestChat({ state: { lobbyChannel: '#lobby', availableChannels: ['#lobby', '#chan'] } });
    chat.rememberLeftLobby('#lobby', true);
    receive(':irc.test 001 me :Welcome');

    assert.ok(sent.includes('JOIN #chan'));
    assert.deepEqual(chat.availableChannels, ['#chan']);
});
