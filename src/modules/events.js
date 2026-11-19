/**
 * Events module (feature "events")
 * Calendar in the channel sidebar: upcoming events of the network, grouped by local day.
 * The server expands recurring events. The list is loaded after each registration and
 * every 15 minutes, so the button knows whether something is coming up. An edition can
 * narrow the list (e.g. to one community) by overriding eventsQuery() and calling
 * loadCommunityEvents() when its filter changes. API: docs/discovery.md.
 */
import { startOfDay } from '../core/formatting.js';

const DAY_MS = 86400000;
const SOON_MS = DAY_MS;
const REFRESH_MS = 15 * 60 * 1000;

/**
 * @typedef {{ event_id: number|string, title: string, starts_at: string, recurrence?: string,
 *             channel?: string|null, community_name?: string }} EventItem
 */

/** Entries with a title and a valid start, channel only if it is one. */
export function normalizeEvents(data) {
    const items = Array.isArray(data?.events) ? data.events : [];
    return items
        .filter(item => item && typeof item.title === 'string' && Number.isFinite(Date.parse(item.starts_at)))
        .map(item => ({
            ...item,
            channel: typeof item.channel === 'string' && item.channel.startsWith('#') ? item.channel : null,
        }));
}

/**
 * Groups events by local day, in start order.
 *
 * @param {EventItem[]} items
 * @param {{ now?: number, locale?: string, today?: string, tomorrow?: string }} options
 * @return {{ key: number, label: string, events: (EventItem & { ts: number, time: string })[] }[]}
 */
export function groupEventsByDay(items, { now = Date.now(), locale = 'en-GB', today = 'Today', tomorrow = 'Tomorrow' } = {}) {
    const groups = new Map();
    const todayStart = startOfDay(now);

    [...items]
        .map(item => ({ ...item, ts: Date.parse(item.starts_at) }))
        .filter(item => Number.isFinite(item.ts))
        .sort((a, b) => a.ts - b.ts)
        .forEach(item => {
            const key = startOfDay(item.ts);
            if (!groups.has(key)) {
                const diffDays = Math.round((key - todayStart) / DAY_MS);
                const label = diffDays === 0 ? today
                    : diffDays === 1 ? tomorrow
                        : new Date(item.ts).toLocaleDateString(locale, { weekday: 'short', day: '2-digit', month: '2-digit' });
                groups.set(key, { key, label, events: [] });
            }
            groups.get(key).events.push({
                ...item,
                time: new Date(item.ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
            });
        });

    return [...groups.values()];
}

export function emptyEventsState() {
    return { open: false, loading: false, failed: false, items: [] };
}

export function eventsMixin() {
    return {
        communityEvents: emptyEventsState(),
        _communityEventsRequest: 0,
        _eventsRefreshTimer: null,

        canUseEvents() {
            return this.hasFeature('events') && this.hasApiToken;
        },

        /** Query parameters for the list; editions override this to filter. */
        eventsQuery() {
            return {};
        },

        /** Whether the list shows where an event belongs (off when the edition filters by group). */
        showsEventSource() {
            return true;
        },

        /** Earliest upcoming start (ms) in the loaded list. */
        nextEventAt() {
            const now = Date.now();
            const starts = this.communityEvents.items
                .map(item => Date.parse(item.starts_at))
                .filter(ts => Number.isFinite(ts) && ts >= now);
            return starts.length ? Math.min(...starts) : null;
        },

        showEventsButton() {
            return this.canUseEvents() && this.nextEventAt() !== null;
        },

        hasEventSoon() {
            const next = this.nextEventAt();
            return next !== null && next - Date.now() <= SOON_MS;
        },

        async toggleCommunityEvents() {
            if (this.communityEvents.open) {
                this.closeCommunityEvents();
                return;
            }
            this.communityEvents.open = true;
            await this.loadCommunityEvents();
        },

        closeCommunityEvents() {
            this.communityEvents.open = false;
        },

        async loadCommunityEvents() {
            if (!this.canUseEvents()) return;
            const request = ++this._communityEventsRequest;
            this.communityEvents.loading = true;
            this.communityEvents.failed = false;
            try {
                const query = new URLSearchParams(this.eventsQuery()).toString();
                const response = await this.connection.api(query ? `chat/events?${query}` : 'chat/events');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const items = normalizeEvents(await response.json());
                if (request !== this._communityEventsRequest) return;
                this.communityEvents.items = items;
            } catch (error) {
                if (request !== this._communityEventsRequest) return;
                console.warn('Could not load events:', error);
                this.communityEvents.failed = true;
            } finally {
                if (request === this._communityEventsRequest) this.communityEvents.loading = false;
            }
        },

        startEventsRefresh() {
            this.stopEventsRefresh();
            if (!this.canUseEvents()) return;
            this._eventsRefreshTimer = setInterval(() => this.loadCommunityEvents(), REFRESH_MS);
        },

        stopEventsRefresh() {
            if (this._eventsRefreshTimer) clearInterval(this._eventsRefreshTimer);
            this._eventsRefreshTimer = null;
        },

        communityEventGroups() {
            return groupEventsByDay(this.communityEvents.items, {
                locale: this.t('locale'),
                today: this.t('today'),
                tomorrow: this.t('events_tomorrow'),
            });
        },

        eventRecurrenceLabel(recurrence) {
            return ['weekly', 'biweekly', 'monthly'].includes(recurrence) ? this.t(`events_recurrence_${recurrence}`) : '';
        },

        openEventChannel(channel) {
            if (!channel) return;
            this.closeCommunityEvents();
            if (this.availableChannels.some(entry => entry.toLowerCase() === channel.toLowerCase())) {
                this.switchChannel(this.resolveTargetKey(channel));
            } else {
                this.joinChannel(channel);
            }
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const eventsModule = {
    name: 'events',
    mixin: eventsMixin,
    hooks: {
        registered() {
            if (!this.canUseEvents()) return;
            this.loadCommunityEvents();
            this.startEventsRefresh();
        },
        loggedOut() {
            this.stopEventsRefresh();
            this.communityEvents = emptyEventsState();
        },
    },
};
