/**
 * Parts of the UI mixins that work without a DOM.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './chat-harness.js';
import { isTrustedAvatarUrl, notificationTag, uiMixin } from '../../src/ui/mixins/ui.js';
import { completionMixin } from '../../src/ui/mixins/completion.js';
import {
    NOTIFICATION_SOUNDS,
    defaultNotificationSound,
    normalizeNotificationSound,
    playsOwnSound,
    registerNotificationSound,
} from '../../src/ui/notification-sound.js';

beforeEach(() => {
    installBrowserStubs();
});

function uiChat(state = {}) {
    const hostMessages = [];
    const chat = Object.assign({}, uiMixin(), {
        features: [],
        connection: { apiBaseUrl: 'https://chat.example.org/api' },
        avatarUrls: {},
        unreadMessages: {},
        mentionsByChannel: {},
        hasFeature(name) {
            return this.features.includes(name);
        },
        notifyHost: (type, data = {}) => hostMessages.push({ type, ...data }),
    }, state);
    return { chat, hostMessages };
}

test('avatars are only trusted from the https API origin of the connection', () => {
    const api = 'https://chat.example.org/api';
    assert.equal(isTrustedAvatarUrl('https://chat.example.org/storage/avatars/a.png', api), true);
    assert.equal(isTrustedAvatarUrl('https://tracker.example.com/a.png', api), false);
    assert.equal(isTrustedAvatarUrl('http://chat.example.org/a.png', 'http://chat.example.org/api'), false);
    assert.equal(isTrustedAvatarUrl('https://chat.example.org/a.png', null), false);
    assert.equal(isTrustedAvatarUrl('not a url', api), false);
});

test('avatars need the profiles feature of the server', () => {
    const { chat } = uiChat();
    chat.setUserAvatar('Bob', 'https://chat.example.org/storage/avatars/bob.png');
    assert.equal(chat.avatarUrl('bob'), '');

    chat.features = ['profiles'];
    chat.setUserAvatar('Bob', 'https://chat.example.org/storage/avatars/bob.png');
    assert.equal(chat.avatarUrl('bob'), 'https://chat.example.org/storage/avatars/bob.png');
    chat.renameUserAvatar('Bob', 'Robert');
    assert.equal(chat.avatarUrl('bob'), '');
    assert.equal(chat.avatarUrl('robert'), 'https://chat.example.org/storage/avatars/bob.png');
});

test('the host gets the unread count without muted channels', () => {
    const { chat, hostMessages } = uiChat({
        unreadMessages: { '#a': 3, '#quiet': 5, '#muted': 9, bob: 1 },
        mentionsByChannel: { '#quiet': 1 },
        channelNotifyLevel: (target) => ({ '#quiet': 'mentions', '#muted': 'mute' }[target] || 'all'),
    });
    chat.emitUnreadState();
    assert.deepEqual(hostMessages, [{ type: 'unread-state-update', totalUnread: 5 }]);
});

test('resetting mentions tells the host', () => {
    const { chat, hostMessages } = uiChat({ hasMentions: true, mentionCount: 4 });
    chat.resetMentions();
    assert.equal(chat.mentionCount, 0);
    assert.deepEqual(hostMessages, [{ type: 'mention-update', hasMentions: false, mentionCount: 0 }]);
});

test('notification tags are per target, case-insensitive', () => {
    assert.equal(notificationTag('#Chan'), 'starchat:#chan');
});

test('message kinds', () => {
    const { chat } = uiChat();
    assert.equal(chat.messageKind({ isJoinPart: true }), 'joinpart');
    assert.equal(chat.messageKind({ user: 'Server' }), 'system');
    assert.equal(chat.messageKind({ user: 'bob', isAction: true }), 'action');
    assert.equal(chat.messageKind({ user: 'bob' }), 'text');
});

test('an edition can add its own sound as the default', () => {
    assert.equal(defaultNotificationSound(), 'chime');
    assert.equal(normalizeNotificationSound('unknown'), 'chime');
    assert.equal(playsOwnSound('system'), false);

    registerNotificationSound('/sounds/highlight.wav');
    assert.equal(NOTIFICATION_SOUNDS[0], 'app');
    assert.equal(defaultNotificationSound(), 'app');
    assert.equal(normalizeNotificationSound('unknown'), 'app');
    assert.equal(playsOwnSound('app'), true);
});

test('tab completion offers the registered commands', () => {
    const chat = Object.assign({}, completionMixin());
    const candidates = chat.completionCandidates('/jo', true).map(candidate => candidate.text);
    assert.ok(candidates.includes('/join'));
});
