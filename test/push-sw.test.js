/**
 * Push service worker: config from its URL, notification text, filter, tapping a notification.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/push-sw.js', import.meta.url), 'utf8');

/** Loads the worker with a fake ServiceWorkerGlobalScope. */
function loadWorker(url = 'https://chat.example.org/push-sw.js', windows = []) {
    const listeners = {};
    const shown = [];
    const opened = [];
    const cacheEntries = new Map();
    const self = {
        location: { href: url },
        addEventListener: (type, listener) => { listeners[type] = listener; },
        registration: { showNotification: async (title, options) => shown.push({ title, ...options }) },
        clients: {
            matchAll: async () => windows,
            openWindow: async (target) => opened.push(target),
            claim: async () => {},
        },
        caches: {
            open: async () => ({
                match: async (key) => cacheEntries.get(key),
                put: async (key, response) => cacheEntries.set(key, response),
            }),
        },
        skipWaiting() {},
    };
    runInNewContext(source, { self, URL, Response, console });

    const dispatch = async (type, event) => {
        let done;
        listeners[type]({ ...event, waitUntil: (promise) => { done = promise; } });
        await done;
    };
    return {
        shown,
        opened,
        push: (line) => dispatch('push', { data: { text: () => line } }),
        click: (target) => dispatch('notificationclick', { notification: { data: { target }, close() {} } }),
        filter: (filter) => dispatch('message', { data: { type: 'push-filter', ...filter } }),
    };
}

test('a direct message shows the sender and opens the configured chat path', async () => {
    const worker = loadWorker('https://chat.example.org/push-sw.js?name=MyNet&chat=/app&icon=/icon.png');
    await worker.push('@msgid=1 :alice!a@host PRIVMSG me :\x02hello\x02 there');
    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0].title, 'alice');
    assert.equal(worker.shown[0].body, 'hello there');
    assert.equal(worker.shown[0].tag, 'starchat:alice');
    assert.equal(worker.shown[0].icon, '/icon.png');

    await worker.click('alice');
    assert.deepEqual(worker.opened, ['/app?open=alice']);
});

test('channel mentions, actions and other lines', async () => {
    const worker = loadWorker('https://chat.example.org/push-sw.js?name=MyNet');
    await worker.push(':bob!b@h PRIVMSG #Bridge :\x01ACTION waves at me\x01');
    await worker.push(':bob!b@h INVITE me #secret');
    assert.deepEqual(worker.shown.map(({ title, body, tag }) => ({ title, body, tag })), [
        { title: 'bob in #Bridge', body: '* bob waves at me', tag: 'starchat:#bridge' },
        { title: 'MyNet', body: 'bob → #secret', tag: 'starchat:invite' },
    ]);
});

test('lines without content show no empty notification', async () => {
    const worker = loadWorker('https://chat.example.org/push-sw.js?name=MyNet');
    await worker.push(':bob!b@h PRIVMSG me :\x01VERSION\x01');
    await worker.push('@time=2026-11-23T10:00:00.000Z;+draft/react=👍;+draft/reply=abc :bob!b@h TAGMSG me');
    await worker.push(':irc.test MARKREAD #chan timestamp=2026-11-23T10:00:00.000Z');
    await worker.push(':irc.test FOO bar');
    assert.equal(worker.shown.length, 0);
});

test('muted channels and ignored users stay silent', async () => {
    const worker = loadWorker();
    await worker.filter({ muted: ['#quiet'], ignored: ['troll'] });
    await worker.push(':alice!a@h PRIVMSG #Quiet :me: hi');
    await worker.push(':Troll!t@h PRIVMSG me :hi');
    await worker.push(':alice!a@h PRIVMSG #loud :me: hi');
    assert.deepEqual(worker.shown.map(entry => entry.title), ['alice in #loud']);
});

test('a visible chat window gets no popup, a tap focuses it and sends the target', async () => {
    const messages = [];
    const chatWindow = {
        url: 'https://chat.example.org/chat/room',
        visibilityState: 'visible',
        focus: async () => {},
        // Copied out of the VM: objects from there have another Object prototype
        postMessage: (message) => messages.push({ ...message }),
    };
    const worker = loadWorker('https://chat.example.org/push-sw.js?chat=/chat', [chatWindow]);
    await worker.push(':alice!a@h PRIVMSG me :hi');
    assert.equal(worker.shown.length, 0);

    await worker.click('alice');
    assert.deepEqual(messages, [{ type: 'open-target', target: 'alice' }]);
    assert.equal(worker.opened.length, 0);
});

test('defaults and unsafe values in the worker URL', async () => {
    const other = { url: 'https://chat.example.org/chatroom', visibilityState: 'visible' };
    const worker = loadWorker('https://chat.example.org/push-sw.js?chat=//evil.test&icon=https://evil.test/x.png');
    await worker.push(':alice!a@h PRIVMSG me :hi');
    assert.equal(worker.shown[0].icon, '/favicon.ico');

    const scoped = loadWorker('https://chat.example.org/push-sw.js?chat=/chat', [other]);
    await scoped.push(':alice!a@h PRIVMSG me :hi');
    assert.equal(scoped.shown.length, 1, '/chatroom is not the chat path /chat');
    await scoped.click(null);
    assert.deepEqual(scoped.opened, ['/chat']);
});
