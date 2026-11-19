/**
 * Events module: loading, grouping by day, button state, filter of the edition.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { eventsModule, groupEventsByDay, normalizeEvents } from '../../src/modules/events.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { json, loggedInChat as baseLoggedInChat } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

afterEach(() => {
    vi.useRealTimers();
});

const NOW = Date.UTC(2026, 10, 19, 12);
const hours = (count) => new Date(NOW + count * 3600000).toISOString();

const EVENTS = {
    events: [
        { event_id: 2, title: 'Later', starts_at: hours(50), recurrence: 'weekly', channel: '#Bridge', community_name: 'Fleet' },
        { event_id: 1, title: 'Soon', starts_at: hours(3), recurrence: 'none', channel: 'nochannel' },
        { event_id: 3, title: 'Broken', starts_at: 'never' },
    ],
};

function loggedInChat(routes = {}, options = {}) {
    return baseLoggedInChat({ 'GET chat/events': json(EVENTS), ...routes }, {
        modules: [eventsModule],
        features: ['events'],
        ...options,
    });
}

test('normalizeEvents drops broken entries and channels without #', () => {
    const items = normalizeEvents(EVENTS);
    assert.deepEqual(items.map(item => item.title), ['Later', 'Soon']);
    assert.equal(items[1].channel, null);
    assert.deepEqual(normalizeEvents(null), []);
});

test('events are grouped by local day in start order', () => {
    const groups = groupEventsByDay(normalizeEvents(EVENTS), { now: NOW, locale: 'en-GB', today: 'Today', tomorrow: 'Tomorrow' });
    assert.equal(groups.length, 2);
    assert.equal(groups[0].label, 'Today');
    assert.deepEqual(groups[0].events.map(item => item.title), ['Soon']);
    assert.notEqual(groups[1].label, 'Tomorrow', 'two days ahead gets a date');
});

test('registration loads the list, the button shows an event within a day', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    const { chat, fetch } = await loggedInChat();
    chat.callModuleHook('registered');
    await vi.waitFor(() => assert.equal(chat.communityEvents.items.length, 2));

    assert.ok(chat.showEventsButton());
    assert.ok(chat.hasEventSoon());
    assert.equal(fetch.calls.filter(call => call.path === 'chat/events').length, 1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    assert.equal(fetch.calls.filter(call => call.path === 'chat/events').length, 2, 'refreshed');

    chat.callModuleHook('loggedOut');
    assert.deepEqual(chat.communityEvents.items, []);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    assert.equal(fetch.calls.filter(call => call.path === 'chat/events').length, 2, 'stopped');
});

test('no button without upcoming events, without the feature or without a token', async () => {
    const { chat } = await loggedInChat({ 'GET chat/events': json({ events: [] }) });
    await chat.loadCommunityEvents();
    assert.ok(!chat.showEventsButton());

    const { chat: plain, fetch } = await loggedInChat({}, { features: [] });
    await plain.loadCommunityEvents();
    assert.ok(!fetch.calls.some(call => call.path.startsWith('chat/events')));

    const { chat: guest } = await loggedInChat();
    guest.hasApiToken = false;
    assert.ok(!guest.canUseEvents());
});

test('a failed load shows the error, an older answer does not overwrite a newer one', async () => {
    const { chat } = await loggedInChat({ 'GET chat/events': json({}, 500) });
    await chat.toggleCommunityEvents();
    assert.ok(chat.communityEvents.open);
    assert.ok(chat.communityEvents.failed);
    assert.ok(!chat.communityEvents.loading);

    let release;
    const slow = new Promise(resolve => { release = resolve; });
    const { chat: racing } = await loggedInChat({
        'GET chat/events': () => slow.then(() => json(EVENTS)),
        'GET chat/events?community=7': json({ events: [] }),
    });
    const first = racing.loadCommunityEvents();
    racing.activeCommunityFilter = 7;
    await racing.loadCommunityEvents();
    release();
    await first;
    assert.deepEqual(racing.communityEvents.items, [], 'the filtered answer stays');
});

test('the channel of an event is opened or joined', async () => {
    const { chat, sent } = await loggedInChat();
    chat.socket = { send: (line) => sent.push(line) };
    chat.availableChannels = ['#bridge'];
    chat.communityEvents.open = true;

    chat.openEventChannel('#Bridge');
    assert.equal(chat.currentChannel, '#bridge');
    assert.ok(!chat.communityEvents.open);

    chat.openEventChannel('#news');
    assert.ok(sent.includes('JOIN #news'));
    assert.equal(chat.eventRecurrenceLabel('weekly'), chat.t('events_recurrence_weekly'));
    assert.equal(chat.eventRecurrenceLabel('none'), '');
});
