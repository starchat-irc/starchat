/**
 * Communities module: list from the API, Home groups, community view, navigation,
 * invite links and the events filter.
 */
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { communitiesModule, normalizeCommunities } from '../../src/modules/communities.js';
import { eventsModule } from '../../src/modules/events.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json, loggedInChat as baseLoggedInChat } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

const COMMUNITIES = [
    { id: 1, name: 'Starfleet', slug: 'starfleet', lobby_channel: '#Bridge', channels: ['#engineering', '#bridge', '#lounge'] },
    { id: 2, name: 'Klingons', slug: 'klingons', lobby_channel: null, channels: ['#qonos', '#lounge'] },
];

async function loggedInChat(routes = {}, options = {}) {
    const result = await baseLoggedInChat(
        { 'GET my-communities': json(COMMUNITIES), ...routes },
        {
            modules: [communitiesModule],
            features: ['communities'],
            links: { communityInvite: 'https://home.example.org/invite/{community}' },
            ...options,
        },
    );
    await result.chat.fetchMyCommunities();
    return result;
}

test('normalizeCommunities cleans channels and picks a lobby that is one of them', () => {
    const list = normalizeCommunities([
        ...COMMUNITIES,
        { id: 1, name: 'Duplicate', channels: [] },
        { id: 3, name: '  ', channels: ['#x'] },
        { name: 'No id', channels: ['#x'] },
        { id: 4, name: 'Odd', slug: 'bad slug', lobby_channel: '#gone', channels: ['Alpha', '#alpha', 'with space', 7] },
        null,
    ]);

    assert.deepEqual(list.map(entry => entry.id), [1, 2, 4]);
    assert.deepEqual(list[0].channels, ['#engineering', '#bridge', '#lounge']);
    assert.equal(list[0].lobby_channel, '#bridge');
    assert.equal(list[1].lobby_channel, '#qonos', 'without a lobby the first channel');
    assert.deepEqual(list[2].channels, ['#alpha']);
    assert.equal(list[2].lobby_channel, '#alpha');
    assert.equal(list[2].slug, '');
    assert.deepEqual(normalizeCommunities({ communities: [COMMUNITIES[0]] }).length, 1);
    assert.deepEqual(normalizeCommunities('nope'), []);
});

test('registration loads the communities, guests and networks without the feature get none', async () => {
    const { chat, fetch } = await loggedInChat();
    assert.equal(chat.myCommunities.length, 2);
    assert.equal(new Headers(fetch.calls.find(call => call.path === 'my-communities').init.headers).get('Authorization'), 'Bearer jwt-1');

    const guestFetch = apiStub({ 'GET my-communities': json(COMMUNITIES) });
    const guest = chatWith(connectionWith(guestFetch, { features: ['communities'] }), { modules: [communitiesModule] }).chat;
    await guest.fetchMyCommunities();
    assert.deepEqual(guest.myCommunities, []);
    assert.equal(guestFetch.calls.length, 0);

    const plain = await loggedInChat({}, { features: [] });
    assert.deepEqual(plain.chat.myCommunities, []);
});

test('Home lists loose channels first, then one group per community with its lobby first', async () => {
    const { chat } = await loggedInChat();
    chat.lobbyChannel = '#welcome';
    chat.availableChannels = ['#lounge', '#zeta', '#bridge', '#welcome', '#alpha', '#qonos', '#engineering'];

    assert.deepEqual(chat.channelListEntries, [
        { name: '#welcome', joined: true },
        { name: '#alpha', joined: true },
        { name: '#zeta', joined: true },
        { name: '#bridge', joined: true, groupLabel: 'Starfleet' },
        { name: '#engineering', joined: true },
        { name: '#lounge', joined: true },
        { name: '#qonos', joined: true, groupLabel: 'Klingons' },
    ]);
});

test('a community lists all of its channels, the ones not joined as joinable', async () => {
    const { chat } = await loggedInChat();
    chat.availableChannels = ['#lounge'];
    chat.activeCommunityFilter = 1;

    assert.deepEqual(chat.channelListEntries, [
        { name: '#bridge', joined: false },
        { name: '#engineering', joined: false },
        { name: '#lounge', joined: true },
    ]);
    assert.equal(chat.sidebarTitle(), 'Starfleet');
    assert.deepEqual(chat.sortedChannels, ['#lounge']);
});

test('opening a community joins its lobby, later it returns to the channel used there', async () => {
    const { chat, sent } = await loggedInChat();
    chat.socket = { send: line => sent.push(line) };
    chat.availableChannels = ['#lounge'];
    const changes = [];
    chat.callModuleHook = (name, ...args) => { if (name === 'communityChanged') changes.push(args[0]); };

    chat.openCommunity(chat.myCommunities[0]);
    assert.equal(chat.activeCommunityFilter, 1);
    assert.ok(sent.includes('JOIN #bridge'));
    assert.deepEqual(changes, [1]);

    chat.availableChannels = ['#lounge', '#bridge'];
    chat.switchChannel('#lounge');
    chat.openHome();
    assert.equal(chat.activeCommunityFilter, null);
    chat.openCommunity(chat.myCommunities[0]);
    assert.equal(chat.currentChannel, '#lounge', 'last channel of the community');
    assert.deepEqual(changes, [1, null, 1]);
});

test('showing a channel outside of the community goes back to Home', async () => {
    const { chat } = await loggedInChat();
    chat.availableChannels = ['#bridge', '#elsewhere'];
    chat.activeCommunityFilter = 1;

    chat.switchChannel('#elsewhere');

    assert.equal(chat.activeCommunityFilter, null);
    assert.equal(chat.lastHomeChannel, '#elsewhere');
});

test('mentions and unread messages are counted per community', async () => {
    const { chat } = await loggedInChat();
    chat.availableChannels = ['#bridge', '#lounge'];
    chat.mentionsByChannel = { '#bridge': 2, '#lounge': 1 };
    chat.unreadMessages = { '#lounge': 3 };

    assert.equal(chat.communityMentionCount(chat.myCommunities[0]), 3);
    assert.equal(chat.communityMentionCount(chat.myCommunities[1]), 1);
    assert.equal(chat.communityHasUnread(chat.myCommunities[1]), true);
});

test('the rail shows five communities and folds the rest', async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, name: `C${index}`, channels: [`#c${index}`] }));
    const { chat } = await loggedInChat({ 'GET my-communities': json(many) });
    assert.equal(chat.visibleCommunities().length, 5);
    assert.equal(chat.hiddenCommunityCount(), 2);
});

test('the invite link needs the network link and a slug', async () => {
    const { chat } = await loggedInChat();
    assert.equal(chat.communityInviteUrl(chat.myCommunities[0]), 'https://home.example.org/invite/starfleet');
    assert.equal(chat.communityInviteUrl({ ...chat.myCommunities[0], slug: '' }), null);
    assert.equal(chat.communityInviteUrl(null), null);

    const unlinked = await loggedInChat({}, { links: {} });
    assert.equal(unlinked.chat.communityInviteUrl(unlinked.chat.myCommunities[0]), null);
});

test('a community that is gone after reloading switches the view back to Home', async () => {
    let list = COMMUNITIES;
    const { chat } = await loggedInChat({ 'GET my-communities': () => json(list) });
    chat.activeCommunityFilter = 2;

    list = [COMMUNITIES[0]];
    await chat.fetchMyCommunities();

    assert.equal(chat.activeCommunityFilter, null);
});

test('logging out forgets the communities', async () => {
    const { chat } = await loggedInChat();
    chat.activeCommunityFilter = 1;
    chat.callModuleHook('loggedOut');
    assert.deepEqual(chat.myCommunities, []);
    assert.equal(chat.activeCommunityFilter, null);
});

test('the events list follows the community shown', async () => {
    const { chat, fetch } = await loggedInChat(
        { 'GET chat/events': json({ events: [] }), 'GET chat/events?community=1': json({ events: [] }) },
        { modules: [communitiesModule, eventsModule], features: ['communities', 'events'] },
    );
    chat.availableChannels = ['#bridge'];

    chat.openCommunity(chat.myCommunities[0]);
    await vi.waitFor(() => assert.ok(fetch.calls.some(call => call.path === 'chat/events?community=1')));
    assert.equal(chat.showsEventSource(), false);

    chat.openHome();
    await vi.waitFor(() => assert.equal(fetch.calls.at(-1).path, 'chat/events'));
    assert.equal(chat.showsEventSource(), true);
});
