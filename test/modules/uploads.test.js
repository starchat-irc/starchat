/**
 * Uploads module and GIFs module.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { uploadErrorKey, uploadsModule } from '../../src/modules/uploads.js';
import { gifsModule, normalizeGifResults } from '../../src/modules/gifs.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json, loggedInChat as baseLoggedInChat } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
    globalThis.URL.createObjectURL ??= () => 'blob:preview';
    globalThis.URL.revokeObjectURL ??= () => {};
});

afterEach(() => {
    vi.useRealTimers();
});

const loggedInChat = (routes, options = {}) => baseLoggedInChat(routes, {
    modules: [uploadsModule, gifsModule],
    features: ['uploads', 'gifs'],
    ...options,
});

const image = () => new File(['x'], 'cat.png', { type: 'image/png' });

/** In a channel, ready to send. */
function inChannel(chat) {
    chat.currentChannel = '#lobby';
    chat.stores.messages.get()['#lobby'] = { type: 'channel', content: [] };
    chat.updateStatus = (text) => { chat.lastStatus = text; };
}

// Uploads

test('uploads need the feature and a token', async () => {
    const guest = chatWith(connectionWith(apiStub({}), { features: ['uploads'] }), { modules: [uploadsModule] }).chat;
    await guest.guestLogin();
    assert.equal(guest.canUploadMedia(), false);

    const { chat } = await loggedInChat();
    assert.equal(chat.canUploadMedia(), true);

    const without = (await loggedInChat({}, { features: [] })).chat;
    assert.equal(without.canUploadMedia(), false);
});

test('the pending file is uploaded and its link sent with the text in front', async () => {
    const { chat, fetch, sent } = await loggedInChat({ 'POST chat/media-upload': json({ id: 7, url: 'https://home.example.org/storage/cat.png' }) });
    inChannel(chat);
    chat.setPendingMedia(image());
    chat.newMessage = 'look';

    await chat.sendMessage();

    const post = fetch.calls.find(call => call.path === 'chat/media-upload');
    assert.equal(post.method, 'POST');
    assert.equal(post.init.body.get('media').name, 'cat.png');
    assert.equal(post.init.body.get('caption'), 'look');
    assert.ok(sent.some(line => line.endsWith('PRIVMSG #lobby :look https://home.example.org/storage/cat.png')));
    assert.equal(chat.pendingMediaFile, null);
    assert.equal(chat.newMessage, '');
    assert.equal(chat.mediaUploadInProgress, false);
});

test('a failed upload keeps file and text and shows a message', async () => {
    const { chat } = await loggedInChat({ 'POST chat/media-upload': json({}, 413) });
    inChannel(chat);
    chat.setPendingMedia(image());
    chat.newMessage = 'look';

    await chat.sendMessage();

    assert.equal(chat.lastStatus, chat.t('upload_too_large'));
    assert.equal(chat.pendingMediaFile.name, 'cat.png');
    assert.equal(chat.newMessage, 'look');
    assert.equal(chat.mediaUploadInProgress, false);
});

test('validation messages of the server win over the generic text', async () => {
    const { chat } = await loggedInChat({ 'POST chat/media-upload': json({ errors: { media: ['Only images'] } }, 422) });
    inChannel(chat);
    chat.setPendingMedia(image());
    await chat.sendPendingMediaMessage();
    assert.equal(chat.lastStatus, 'Only images');
});

test('error texts by status', () => {
    assert.equal(uploadErrorKey(413), 'upload_too_large');
    assert.equal(uploadErrorKey(422), 'upload_invalid');
    assert.equal(uploadErrorKey(502), 'upload_server_error');
    assert.equal(uploadErrorKey(400), 'upload_failed');
});

test('a hanging upload unlocks the input after 30 seconds', async () => {
    vi.useFakeTimers();
    const { chat } = await loggedInChat();
    inChannel(chat);
    chat.beginMediaUpload();
    assert.equal(chat.mediaUploadInProgress, true);
    vi.advanceTimersByTime(30000);
    assert.equal(chat.mediaUploadInProgress, false);
    assert.equal(chat.lastStatus, chat.t('upload_reset'));
});

test('paste and drop take images and videos only', async () => {
    const { chat } = await loggedInChat();
    let prevented = false;
    chat.handlePasteUpload({
        clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }, { type: 'image/png', getAsFile: () => image() }] },
        preventDefault: () => { prevented = true; },
    });
    assert.ok(prevented);
    assert.match(chat.pendingMediaFile.name, /^pasted-.*\.png$/);

    chat.clearPendingMedia();
    chat.handleInputDrop({ dataTransfer: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
    assert.equal(chat.pendingMediaFile, null);
    chat.handleInputDrop({ dataTransfer: { files: [new File(['x'], 'a.webm', { type: 'video/webm' })] } });
    assert.equal(chat.pendingMediaFile.name, 'a.webm');
    assert.equal(chat.isPendingMediaImage(), false);
});

test('the upload manager lists and deletes own uploads', async () => {
    const { chat, fetch } = await loggedInChat({
        'GET chat/media-upload': json({ uploads: [{ id: 1, url: 'https://home.example.org/a.png', mime_type: 'image/png' }, { id: 2, mime_type: 'video/mp4' }, null] }),
        'DELETE chat/media-upload/1': json({}),
    });

    await chat.fetchMyUploads();
    assert.deepEqual(chat.myUploads.map(upload => upload.id), [1, 2]);
    assert.equal(chat.isUploadImage(chat.myUploads[0]), true);
    assert.equal(chat.isUploadVideo(chat.myUploads[1]), true);

    await chat.deleteUpload(chat.myUploads[0]);
    assert.equal(fetch.calls.at(-1).method, 'DELETE');
    assert.deepEqual(chat.myUploads.map(upload => upload.id), [2]);
});

test('logout drops the pending file and the list', async () => {
    const { chat } = await loggedInChat();
    chat.setPendingMedia(image());
    chat.myUploads = [{ id: 1 }];
    chat.logout();
    assert.equal(chat.pendingMediaFile, null);
    assert.deepEqual(chat.myUploads, []);
});

// GIFs

const gif = (id) => ({ id, title: `gif ${id}`, url: `https://media.example.net/${id}.gif`, preview: `https://media.example.net/${id}.webp` });

test('normalizeGifResults keeps https results and a valid provider', () => {
    const data = normalizeGifResults({
        results: [gif('a'), { ...gif('b'), url: 'http://media.example.net/b.gif' }, { ...gif('c'), preview: 'javascript:x' }, null],
        next: 2,
        provider: { name: 'GifNet', url: 'https://gifs.example.net' },
    });
    assert.deepEqual(data.results.map(result => result.id), ['a']);
    assert.equal(data.next, '2');
    assert.deepEqual(data.provider, { name: 'GifNet', url: 'https://gifs.example.net' });

    assert.equal(normalizeGifResults({ provider: { name: 'x', url: 'javascript:alert(1)' } }).provider, null);
    assert.deepEqual(normalizeGifResults(null), { results: [], next: null, provider: null });
});

test('opening the picker loads trending GIFs, search and paging add parameters', async () => {
    const { chat, fetch } = await loggedInChat({
        'GET gifs/search?limit=20': json({ results: [gif('a')], next: 2, provider: { name: 'GifNet', url: 'https://gifs.example.net' } }),
        'GET gifs/search?limit=20&q=cats': json({ results: [gif('b')], next: 2 }),
        'GET gifs/search?limit=20&q=cats&page=2': json({ results: [gif('c')], next: null }),
    });

    await chat.openGifPickerResults();
    assert.deepEqual(chat.gifPicker.results.map(result => result.id), ['a']);
    assert.equal(chat.gifPicker.provider.name, 'GifNet');

    chat.gifPicker.search = ' cats ';
    await chat.searchGifs();
    assert.deepEqual(chat.gifPicker.results.map(result => result.id), ['b']);

    await chat.loadMoreGifs();
    await vi.waitFor(() => assert.equal(chat.gifPicker.loading, false));
    assert.deepEqual(chat.gifPicker.results.map(result => result.id), ['b', 'c']);
    assert.equal(chat.gifPicker.nextPage, null);

    const before = fetch.calls.length;
    chat.loadMoreGifs();
    assert.equal(fetch.calls.length, before);
});

test('an older search answer does not replace a newer one', async () => {
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const { chat } = await loggedInChat({
        'GET gifs/search?limit=20&q=ca': () => slow,
        'GET gifs/search?limit=20&q=cats': json({ results: [gif('new')] }),
    });

    chat.gifPicker.search = 'ca';
    const first = chat.searchGifs();
    chat.gifPicker.search = 'cats';
    await chat.searchGifs();
    releaseSlow(json({ results: [gif('old')] }));
    await first;

    assert.deepEqual(chat.gifPicker.results.map(result => result.id), ['new']);
    assert.equal(chat.gifPicker.loading, false);
});

test('a failed search shows the error text, GIFs work without a token', async () => {
    const fetch = apiStub({ 'GET gifs/search?limit=20': json({}, 503) });
    const guest = chatWith(connectionWith(fetch, { features: ['gifs'] }), { modules: [gifsModule] }).chat;
    await guest.guestLogin();

    await guest.openGifPickerResults();

    assert.equal(fetch.calls.length, 1);
    assert.equal(guest.gifPicker.failed, true);
    assert.deepEqual(guest.gifPicker.results, []);
});

test('picking a GIF sends its URL and closes the picker', async () => {
    const { chat, sent } = await loggedInChat();
    inChannel(chat);
    chat.showGifPicker = true;
    chat.sendGif(gif('a'));
    assert.equal(chat.showGifPicker, false);
    assert.ok(sent.some(line => line.endsWith('PRIVMSG #lobby :https://media.example.net/a.gif')));
});
