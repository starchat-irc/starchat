/**
 * Explore dialog: channel list of the server (core) and the directory (explore module).
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { exploreModule, normalizeDirectory } from '../../src/modules/explore.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json, registered } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

const DIRECTORY = {
    communities: [
        { id: 1, name: 'Starfleet', description: 'Roleplay', channel_names: ['#bridge', '#Lobby'] },
        { id: 2, name: 'Empty', channel_names: [] },
        { name: 'Broken', channel_names: 'x' },
    ],
};

function exploreChat(routes = {}, features = ['explore']) {
    const fetch = apiStub(routes);
    const { chat, sent } = chatWith(connectionWith(fetch, { features }), { modules: [exploreModule] });
    registered(chat);
    chat.socket = { send: (line) => sent.push(line) };
    chat.availableChannels = ['#lobby'];
    return { chat, sent, fetch };
}

test('the channel list works on every server', () => {
    const { chat, sent } = exploreChat({}, []);
    chat.openExplore();
    assert.ok(chat.exploreDialog.show);
    assert.equal(chat.exploreDialog.tab, 'list');
    assert.ok(chat.isListing);
    assert.deepEqual(sent.filter(line => line === 'LIST'), ['LIST']);

    chat.serverChannels = [
        { name: '#small', users: 2, topic: '' },
        { name: '#big', users: 40, topic: 'Big talk' },
        { name: '#Lobby', users: 9, topic: '' },
    ];
    assert.deepEqual(chat.filteredServerChannels.map(channel => channel.name), ['#big', '#Lobby', '#small']);
    chat.exploreSearch = 'talk';
    assert.deepEqual(chat.filteredServerChannels.map(channel => channel.name), ['#big']);
    assert.ok(chat.isChannelJoined('#LOBBY'));
    assert.ok(!chat.isChannelJoined('#big'));

    chat.closeExplore();
    assert.ok(!chat.exploreDialog.show);
});

test('joining from the list keeps the dialog open', () => {
    const { chat, sent } = exploreChat();
    chat.openExplore();
    chat.joinChannel('#big');
    assert.ok(sent.includes('JOIN #big'));
    assert.ok(chat.exploreDialog.show);
});

test('the directory tab loads the groups from the API', async () => {
    const { chat, fetch } = exploreChat({ 'GET explore': json(DIRECTORY) });
    chat.openExplore();
    chat.showExploreTab('directory');
    await new Promise(resolve => setTimeout(resolve));

    assert.equal(fetch.calls[0].path, 'explore');
    assert.deepEqual(chat.communities.map(group => group.name), ['Starfleet']);
    assert.ok(!chat.directoryLoading);
    assert.ok(!chat.directoryError);
});

test('joining a group joins only the missing channels and closes the dialog', () => {
    const { chat, sent } = exploreChat();
    const [group] = normalizeDirectory(DIRECTORY);
    chat.openExplore('directory');
    assert.deepEqual(chat.missingCommunityChannels(group), ['#bridge']);
    assert.ok(!chat.isCommunityJoined(group));

    chat.joinCommunity(group);
    assert.ok(sent.includes('JOIN #bridge'));
    assert.ok(!sent.includes('JOIN #Lobby'));
    assert.ok(!chat.exploreDialog.show);
});

test('a failing directory shows an error, servers without the feature are not asked', async () => {
    const { chat } = exploreChat({ 'GET explore': json({}, 500) });
    await chat.fetchDirectory();
    assert.ok(chat.directoryError);
    assert.deepEqual(chat.communities, []);

    const { chat: plain, fetch } = exploreChat({}, []);
    plain.showExploreTab('directory');
    await plain.fetchDirectory();
    assert.equal(fetch.calls.length, 0);
});

test('normalizeDirectory keeps groups with channel names only', () => {
    assert.deepEqual(normalizeDirectory(null), []);
    assert.deepEqual(normalizeDirectory({ communities: [{ name: 'A', channel_names: ['#a', 'b', 3] }] }),
        [{ id: 'A', name: 'A', description: '', channel_names: ['#a'] }]);
});
