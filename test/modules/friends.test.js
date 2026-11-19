/**
 * Friends module: list from the API, requests, presence over MONITOR.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { friendsModule, normalizeFriends } from '../../src/modules/friends.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json, loggedInChat as baseLoggedInChat } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

afterEach(() => {
    vi.useRealTimers();
});

const entry = (id, display, extra = {}) => ({ friendship_id: id, status: 'accepted', user: { display, name: display }, ...extra });

const LIST = {
    friends: [entry(1, 'Bob'), entry(2, 'carol')],
    incoming_requests: [entry(3, 'Dave', { status: 'pending', direction: 'incoming' })],
    outgoing_requests: [entry(4, 'Eve', { status: 'pending', direction: 'outgoing' })],
    blocked: [],
};

const loggedInChat = (routes, options = {}) => baseLoggedInChat(
    { 'GET friends': json(LIST), ...routes },
    { modules: [friendsModule], features: ['friends'], ...options },
);

test('normalizeFriends fills missing lists and drops entries without a nick', () => {
    const data = normalizeFriends({ friends: [entry(1, 'Bob'), { friendship_id: 2 }, null], blocked: 'x' });
    assert.deepEqual(data.friends.map(f => f.user.display), ['Bob']);
    assert.deepEqual(data.incoming, []);
    assert.deepEqual(data.outgoing, []);
    assert.deepEqual(data.blocked, []);
    assert.deepEqual(normalizeFriends(null).friends, []);
});

test('registration loads the list and monitors the friends', async () => {
    const { chat, sent } = await loggedInChat();

    chat.callModuleHook('registered');
    await vi.waitFor(() => assert.equal(chat.friends.length, 2));

    assert.equal(chat.incomingFriendRequests[0].user.display, 'Dave');
    assert.equal(chat.pendingFriendRequestCount, 1);
    assert.ok(sent.includes('MONITOR C'));
    assert.ok(sent.includes('MONITOR + Bob,carol'));
    assert.ok(sent.includes('WHOIS Bob,carol'));
    chat.stopFriendPolling();
});

test('MONITOR is sent again only when the list changed', async () => {
    const { chat, sent } = await loggedInChat();
    await chat.fetchFriends();
    const count = sent.filter(line => line === 'MONITOR C').length;
    await chat.fetchFriends();
    assert.equal(sent.filter(line => line === 'MONITOR C').length, count);
});

test('the list is polled until logout', async () => {
    vi.useFakeTimers();
    const { chat, fetch } = await loggedInChat();
    chat.startFriendPolling();

    await vi.advanceTimersByTimeAsync(20000);
    assert.equal(fetch.calls.filter(call => call.path === 'friends').length, 2);

    chat.logout();
    assert.deepEqual(chat.friends, []);
    await vi.advanceTimersByTimeAsync(20000);
    assert.equal(fetch.calls.filter(call => call.path === 'friends').length, 2);
});

test('an expired token stops polling', async () => {
    vi.useFakeTimers();
    const { chat } = await loggedInChat({ 'GET friends': json({}, 401) });
    chat.startFriendPolling();
    await chat.fetchFriends();
    assert.equal(chat._friendPollTimer, null);
});

test('without a token or the feature nothing is loaded', async () => {
    const guestFetch = apiStub({});
    const guest = chatWith(connectionWith(guestFetch, { features: ['friends'] }), { modules: [friendsModule] }).chat;
    await guest.guestLogin();
    guest.callModuleHook('registered');
    assert.equal(guest.canUseFriends(), false);
    assert.equal(guestFetch.calls.length, 0);

    const { chat, fetch } = await loggedInChat({}, { features: ['profiles'] });
    chat.callModuleHook('registered');
    assert.equal(chat.hasFeature('friends'), false);
    assert.equal(fetch.calls.some(call => call.path === 'friends'), false);
});

test('a request posts the nick and reloads the list', async () => {
    const { chat, fetch } = await loggedInChat({ 'POST friends/request': json({ message: 'Gesendet.' }) });
    chat.friendRequestInput = '  Frank ';

    await chat.sendFriendRequest();

    const post = fetch.calls.find(call => call.path === 'friends/request');
    assert.deepEqual(JSON.parse(post.init.body), { nick: 'Frank' });
    assert.equal(chat.friendNotice, chat.t('friends_request_sent'));
    assert.equal(chat.friendRequestInput, '');
    assert.equal(fetch.calls.at(-1).path, 'friends');
});

test('a request to someone who already asked is accepted', async () => {
    const { chat } = await loggedInChat({ 'POST friends/request': json({ auto_accepted: true }) });
    chat.friendRequestInput = 'Dave';
    await chat.sendFriendRequest();
    assert.equal(chat.friendNotice, chat.t('friends_accepted'));
});

test('validation errors of a request are shown and keep the input', async () => {
    const { chat } = await loggedInChat({ 'POST friends/request': json({ message: 'x', errors: { nick: ['Not found'] } }, 422) });
    chat.friendRequestInput = 'Nobody';
    await chat.sendFriendRequest();
    assert.equal(chat.friendNotice, 'Not found');
    assert.equal(chat.friendRequestInput, 'Nobody');
});

test('actions use the documented paths', async () => {
    const { chat, fetch } = await loggedInChat({
        'POST friends/3/accept': json({}),
        'POST friends/3/decline': json({}),
        'POST friends/3/block': json({}),
        'DELETE friends/1': json({}),
    });

    await chat.friendAction(3, 'accept');
    assert.equal(chat.friendNotice, chat.t('friends_accepted'));
    await chat.friendAction(3, 'decline');
    await chat.friendAction(3, 'block');
    await chat.friendAction(1, 'unfriend');
    assert.equal(chat.friendNotice, chat.t('friends_removed'));

    const actions = fetch.calls.filter(call => call.path !== 'friends' && call.path !== 'login').map(call => `${call.method} ${call.path}`);
    assert.deepEqual(actions, ['POST friends/3/accept', 'POST friends/3/decline', 'POST friends/3/block', 'DELETE friends/1']);

    const before = fetch.calls.length;
    await chat.friendAction(1, 'delete-everything');
    assert.equal(fetch.calls.length, before);
});

test('presence from MONITOR and the lists built from it', async () => {
    const { chat } = await loggedInChat();
    await chat.fetchFriends();
    chat.messageManager.ensure('carol');

    chat.handleMessage({ data: ':irc.example.org 730 alice :Bob!b@host,carol!c@host' });
    assert.equal(chat.friendState('Bob'), 'online');
    assert.equal(chat.isFriendOnline('carol'), true);
    assert.deepEqual(chat.onlineFriendsWithoutDm().map(f => f.user.display), ['Bob']);
    assert.deepEqual(chat.friendDmKeys(), ['carol']);
    assert.deepEqual(chat.friendTabCounts(), { online: 2, all: 2, pending: 2 });

    chat.handleMessage({ data: ':irc.example.org 731 alice :Bob' });
    assert.equal(chat.isFriendOnline('Bob'), false);
    chat.friendFilter = 'online';
    assert.deepEqual(chat.filteredFriendList().map(f => f.user.display), ['carol']);
    chat.friendFilter = 'all';
    assert.deepEqual(chat.filteredFriendList().map(f => f.user.display), ['carol', 'Bob']);
    chat.friendSearch = 'BO';
    assert.deepEqual(chat.filteredFriendList().map(f => f.user.display), ['Bob']);
});

test('the user card offers a request only for accounts without a friendship', async () => {
    const { chat, fetch } = await loggedInChat({ 'POST friends/request': json({}) });
    await chat.fetchFriends();
    chat.nickname = 'alice';

    chat.selectedUser = 'Bobby';
    chat.profileCard.account = 'Bob';
    assert.equal(chat.profileFriendStatus(), 'friend');
    assert.equal(chat.canAddProfileFriend(), false);

    chat.profileCard.account = 'Eve';
    assert.equal(chat.profileFriendStatus(), 'pending');

    chat.profileCard.account = null;
    chat.selectedUser = 'Guest42';
    assert.equal(chat.canAddProfileFriend(), false);

    chat.selectedUser = 'Franky';
    chat.profileCard.account = 'Frank';
    assert.equal(chat.canAddProfileFriend(), true);
    await chat.addFriendFromProfileCard();
    assert.deepEqual(JSON.parse(fetch.calls.find(call => call.path === 'friends/request').init.body), { nick: 'Frank' });
});
