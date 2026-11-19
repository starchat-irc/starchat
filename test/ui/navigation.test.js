/**
 * Leaving channels with /part and from the channel list.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createTestChat, installBrowserStubs } from './chat-harness.js';
import { commands } from '../../src/core/commands.js';

beforeEach(() => {
    installBrowserStubs();
});

/** A registered chat in #chan and #other, showing #chan. */
function joinedChat() {
    const harness = createTestChat();
    harness.receive(':irc.test 001 me :Welcome');
    harness.receive(':me!u@h JOIN #chan');
    harness.receive(':me!u@h JOIN #other');
    harness.chat.switchChannel('#chan');
    harness.sent.length = 0;
    return harness;
}

test('/part without a channel leaves the current one', () => {
    const { chat, sent } = joinedChat();
    commands.part([], chat);

    assert.deepEqual(sent.filter((line) => line.startsWith('PART')), ['PART #chan']);
    assert.ok(!chat.availableChannels.includes('#chan'));
    assert.equal(chat.currentChannel, '#other');
});

test('/part without a channel does nothing outside a channel', () => {
    const { chat, sent } = joinedChat();
    chat.currentChannel = 'alice';
    commands.part([], chat);

    assert.deepEqual(sent.filter((line) => line.startsWith('PART')), []);
});

test('/part with channels leaves those, with or without #', () => {
    const { chat, sent } = joinedChat();
    commands.part(['other,#chan'], chat);

    assert.deepEqual(sent.filter((line) => line.startsWith('PART')), ['PART #other', 'PART #chan']);
});
