/**
 * Share module (content shared from other apps) and the network links (invites, register).
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeShare, shareModule, SHARE_TEXT_LIMIT } from '../../src/modules/share.js';
import { uploadsModule } from '../../src/modules/uploads.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, registered } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

test('normalizeShare joins subject and text and drops empty shares', () => {
    assert.equal(normalizeShare(null), null);
    assert.equal(normalizeShare({ text: '  ' }), null);
    assert.equal(normalizeShare({ subject: 'Title', text: 'https://x.test' }).text, 'Title https://x.test');
    assert.equal(normalizeShare({ subject: 'Title', text: 'Title https://x.test' }).text, 'Title https://x.test');
    assert.equal(normalizeShare({ subject: 'Only subject' }).text, 'Only subject');
    assert.equal(normalizeShare({ text: 'x'.repeat(5000) }).text.length, SHARE_TEXT_LIMIT);
    assert.equal(normalizeShare({ tooLarge: 'big.mp4' }).tooLarge, 'big.mp4');
    assert.equal(normalizeShare({ file: { data: '%%%', name: 'bad' } }), null, 'broken base64 is no file');

    const share = normalizeShare({ file: { data: btoa('hello'), name: 'a.txt', mimeType: 'text/plain' } });
    assert.equal(share.file.name, 'a.txt');
    assert.equal(share.file.size, 5);
});

test('a share waits for the registration, then the switcher asks where to send it', () => {
    const { chat } = chatWith(connectionWith(apiStub({}), { features: [] }), { modules: [shareModule] });
    assert.ok(chat.hasModule('share'));

    chat.receiveShare({ text: 'look at this' });
    assert.ok(!chat.quickSwitcher.show, 'not registered yet');

    registered(chat);
    chat.showPendingShare();
    assert.ok(chat.quickSwitcher.show);
    assert.equal(chat.quickSwitcher.mode, 'share');
    assert.equal(chat.pendingShareSummary(), 'look at this');
});

test('a shared file needs uploads, the text goes into the input', () => {
    const { chat } = chatWith(connectionWith(apiStub({}), { features: [] }), { modules: [shareModule, uploadsModule] });
    chat.newMessage = 'hi';
    chat.receiveShare({ text: 'https://x.test', file: { data: btoa('img'), name: 'p.png', mimeType: 'image/png' } });
    assert.equal(chat.pendingShareWarning(), chat.t('share_file_account_only'));

    chat.applyShare(chat.pendingShare);
    assert.equal(chat.newMessage, 'hi https://x.test');
    assert.equal(chat.pendingMedia ?? null, null, 'no upload without the feature');
});

test('invite and register links come from discovery', async () => {
    const links = { register: 'https://home.example.org/register', channelInvite: 'https://home.example.org/invite/channel/{channel}' };
    const { chat } = chatWith(connectionWith(apiStub({}), { features: [], links }));

    assert.equal(chat.channelInviteUrl('#Schimäre'), 'https://home.example.org/invite/channel/Schim%C3%A4re');
    assert.equal(chat.channelInviteUrl('#bad name'), null);
    assert.equal(chat.registerUrl(), 'https://home.example.org/register');
    chat.selectedServerId = 'other';
    assert.equal(chat.registerUrl(), '', 'another server has its own pages');

    const copied = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text) => { copied.push(text); } } });
    chat.contextMenu = { show: true };
    await chat.copyInviteLink(chat.channelInviteUrl('#lobby'));
    assert.deepEqual(copied, ['https://home.example.org/invite/channel/lobby']);
    assert.ok(!chat.contextMenu.show);

    const { chat: plain } = chatWith(connectionWith(apiStub({}), { features: [] }));
    assert.equal(plain.channelInviteUrl('#lobby'), null);
    assert.equal(plain.registerUrl(), '');
});
