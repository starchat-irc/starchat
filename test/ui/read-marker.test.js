/**
 * draft/read-marker: another session of the account moves the read marker, this one follows.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './chat-harness.js';
import { loggedInChat } from '../modules/module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const TIME = '2026-11-23T10:00:00.000Z';
const dm = (from, text, time = TIME) => `@time=${time};msgid=m-${time} :${from}!u@h PRIVMSG alice :${text}`;

async function readerChat() {
    const result = await loggedInChat({});
    const { chat } = result;
    chat.nickname = 'alice';
    chat.supportsReadMarker = true;
    chat.availableChannels = ['#lobby'];
    chat.currentChannel = '#lobby';
    return result;
}

test('a DM read in another session is no longer unread here', async () => {
    const { chat } = await readerChat();
    chat.handleMessage({ data: dm('Bob', 'hi') });
    assert.equal(chat.unreadMessages.Bob, 1);

    chat.handleMessage({ data: `:server MARKREAD Bob timestamp=${TIME}` });
    assert.equal(chat.unreadMessages.Bob, 0);
});

test('after a reconnect the DMs ask for their read marker, which clears what was read elsewhere', async () => {
    const { chat, sent } = await readerChat();
    chat.handleMessage({ data: dm('Bob', 'before the phone slept', '2026-11-23T09:00:00.000Z') });
    chat.handleMessage({ data: `:server MARKREAD Bob timestamp=2026-11-23T09:00:00.000Z` });
    assert.equal(chat.unreadMessages.Bob, 0);

    // Phone asleep: Bob writes, the desktop reads and answers. Then the app reconnects.
    sent.length = 0;
    chat.handleMessage({ data: ':server 001 alice :Welcome' });
    assert.ok(sent.includes('MARKREAD Bob'), 'DMs have no JOIN, so the client asks');

    // The missed message comes from the history, the marker of the other session after it
    chat.handleMessage({ data: dm('Bob', 'missed', TIME) });
    assert.equal(chat.unreadMessages.Bob, 1);
    chat.handleMessage({ data: `:server MARKREAD Bob timestamp=${TIME}` });
    assert.equal(chat.unreadMessages.Bob, 0);
});

test('a marker that brings nothing new still fixes a stale restored counter', async () => {
    const { chat } = await readerChat();
    chat.handleMessage({ data: dm('Bob', 'hi') });
    chat.handleMessage({ data: `:server MARKREAD Bob timestamp=${TIME}` });
    // As restored from the saved chat state of another device
    chat.unreadMessages.Bob = 3;

    chat.handleMessage({ data: `:server MARKREAD Bob timestamp=${TIME}` });
    assert.equal(chat.unreadMessages.Bob, 0);
});

test('the marker of a DM also applies when the server sends the nick casefolded', async () => {
    const { chat } = await readerChat();
    chat.handleMessage({ data: dm('Bob', 'hi') });

    chat.handleMessage({ data: `:server MARKREAD bob timestamp=${TIME}` });
    assert.equal(chat.unreadMessages.Bob, 0);
});
