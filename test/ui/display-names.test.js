/**
 * Display names (IRCv3 metadata key "display-name").
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createTestChat, installBrowserStubs } from './chat-harness.js';
import { commands } from '../../src/core/commands.js';
import { normalizeDisplayName } from '../../src/ui/mixins/display-names.js';

beforeEach(() => {
    installBrowserStubs();
});

/** A registered chat with metadata support that sits in #chan. */
function joinedChat(state = {}) {
    const harness = createTestChat({ state: { supportsMetadata: true, ...state } });
    harness.receive(':irc.test 001 me :Welcome');
    harness.receive(':me!u@h JOIN #chan');
    harness.chat.switchChannel('#chan');
    harness.sent.length = 0;
    return harness;
}

test('display names are one line, without invisible characters and at most 32 characters', () => {
    assert.equal(normalizeDisplayName('  Captain\u0003 ‮Picard\n '), 'Captain Picard');
    assert.equal(normalizeDisplayName('x'.repeat(40)).length, 32);
    assert.equal(normalizeDisplayName(null), '');
});

test('the display name of another user is shown, the nick stays available', () => {
    const { chat, receive } = joinedChat();
    receive(':irc.test 761 me bob display-name * :Bob Builder');

    assert.equal(chat.displayName('bob'), 'Bob Builder');
    assert.equal(chat.shownName('Bob'), 'Bob Builder');
    assert.equal(chat.nameWithNick('bob'), 'Bob Builder (bob)');

    receive(':irc.test 766 me bob display-name :Key not set');
    assert.equal(chat.shownName('bob'), 'bob');
    assert.equal(chat.nameWithNick('bob'), 'bob');
});

test('a display name that only repeats the nick is not shown as one', () => {
    const { chat, receive } = joinedChat();
    receive(':irc.test 761 me bob display-name * :BOB');
    assert.equal(chat.displayName('bob'), '');
});

test('the display name moves with a nick change', () => {
    const { chat, receive } = joinedChat();
    receive(':bob!u@h JOIN #chan');
    receive(':irc.test 761 me bob display-name * :Bob Builder');
    receive(':bob!u@h NICK robert');

    assert.equal(chat.displayName('robert'), 'Bob Builder');
    assert.equal(chat.displayName('bob'), '');
});

test('after connecting the key is subscribed and the own value is asked for', () => {
    const { sent, receive } = createTestChat({ state: { supportsMetadata: true } });
    receive(':irc.test 001 me :Welcome');

    assert.ok(sent.includes('METADATA * SUB playing status display-name'));
    assert.ok(sent.includes('METADATA me GET display-name'));
});

test('a value on the server wins over the stored one', () => {
    const { chat, sent, receive } = createTestChat({ state: { supportsMetadata: true } });
    chat.setOwnDisplayName('Old Name');
    receive(':irc.test 001 me :Welcome');
    receive(':irc.test 761 me me display-name * :New Name');

    assert.equal(chat.ownDisplayName, 'New Name');
    assert.equal(chat.displayName('me'), 'New Name');
    assert.ok(!sent.some(line => line.startsWith('METADATA * SET display-name')));
});

test('without a value on the server the stored one is published', () => {
    const { chat, sent, receive } = createTestChat({ state: { supportsMetadata: true } });
    chat.setOwnDisplayName('Captain');
    receive(':irc.test 001 me :Welcome');
    receive(':irc.test 766 me me display-name :Key not set');

    assert.ok(sent.includes('METADATA * SET display-name :Captain'));
    assert.equal(chat.ownDisplayName, 'Captain');
});

test('/displayname sets the name, without a name it is removed', () => {
    const { chat, sent } = joinedChat();
    commands.displayname(['Captain', 'Picard'], chat);

    assert.equal(chat.ownDisplayName, 'Captain Picard');
    assert.equal(chat.displayName('me'), 'Captain Picard');
    assert.ok(sent.includes('METADATA * SET display-name :Captain Picard'));

    commands.displayname([], chat);
    assert.equal(chat.ownDisplayName, '');
    assert.equal(sent.at(-1), 'METADATA * SET display-name');
});

test('/displayname does nothing on a server without metadata', () => {
    const { chat, sent } = joinedChat({ supportsMetadata: false });
    commands.displayname(['Captain'], chat);

    assert.equal(chat.ownDisplayName, '');
    assert.ok(!sent.some(line => line.startsWith('METADATA')));
});

test('the field in the own profile card saves and publishes', () => {
    const { chat, sent } = joinedChat();
    chat.displayNameDraft = '  Number One ';
    chat.saveDisplayNameDraft();

    assert.equal(chat.ownDisplayName, 'Number One');
    assert.equal(chat.displayNameDraft, 'Number One');
    assert.ok(sent.includes('METADATA * SET display-name :Number One'));
});
