/**
 * StarChat push service worker (IRCv3 draft/webpush).
 *
 * Copy this file to the origin of the chat page and pass its URL as `pushWorker` to
 * mountChat(). Settings come from the query string of that URL:
 *   name  Title of notifications without a sender (default "StarChat")
 *   chat  Path of the chat page, opened when a notification is tapped (default "/").
 *         May be given more than once: every listed path counts as a chat window,
 *         the first one is opened.
 *   icon  Notification icon (default "/favicon.ico")
 * Example: /push-sw.js?name=MyNet&chat=/chat&icon=/icon.png
 *
 * The IRC server sends the raw IRC line of a direct message or mention; the browser has
 * already decrypted it. A visible chat window shows the message itself, so no popup then.
 * Tapping a notification focuses the chat (or opens it with ?open=<target>) and switches to
 * the conversation. Muted channels and ignored users (sent by the chat as "push-filter")
 * stay silent.
 */

const TAG_PREFIX = 'starchat:';
const FILTER_CACHE = 'starchat-push';
const FILTER_URL = 'push-filter';
const FORMATTING_CODES = /\x03(\d{1,2}(,\d{1,2})?)?|[\x02\x0F\x16\x1D\x1E\x1F\x11]/g;

function readConfig(location) {
    const params = new URL(location).searchParams;
    const paths = params.getAll('chat').filter((path) => path.startsWith('/') && !path.startsWith('//'));
    const icon = params.get('icon') || '/favicon.ico';
    return {
        name: (params.get('name') || 'StarChat').slice(0, 60),
        chatPaths: paths.length ? paths : ['/'],
        icon: icon.startsWith('/') && !icon.startsWith('//') ? icon : '/favicon.ico',
    };
}

const config = readConfig(self.location.href);

function unescapeTagValue(value) {
    return value.replace(/\\(.)/g, (match, char) => ({ ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' }[char] ?? char));
}

/** Splits one IRC line into tags, source nick, command and params. */
function parseIrcLine(line) {
    let rest = String(line || '').replace(/[\r\n]+$/, '');
    const tags = {};
    if (rest.startsWith('@')) {
        const end = rest.indexOf(' ');
        for (const pair of rest.slice(1, end).split(';')) {
            const eq = pair.indexOf('=');
            if (eq === -1) tags[pair] = '';
            else tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
        }
        rest = rest.slice(end + 1).trimStart();
    }
    let nick = '';
    if (rest.startsWith(':')) {
        const end = rest.indexOf(' ');
        nick = rest.slice(1, end).split('!')[0];
        rest = rest.slice(end + 1).trimStart();
    }
    const trailingAt = rest.indexOf(' :');
    const head = trailingAt === -1 ? rest : rest.slice(0, trailingAt);
    const params = head.split(' ').filter(Boolean);
    const command = (params.shift() || '').toUpperCase();
    if (trailingAt !== -1) params.push(rest.slice(trailingAt + 2));
    return { tags, nick, command, params };
}

/**
 * Turns the pushed IRC line into notification content.
 *
 * @return {{ title: string, body: string, target: string|null, tag: string, sender?: string, channel?: string|null }}
 */
function buildPushNotification(line) {
    const { nick, command, params } = parseIrcLine(line);
    const fallback = { title: config.name, body: '', target: null, tag: `${TAG_PREFIX}server` };

    if (command !== 'PRIVMSG' && command !== 'NOTICE') {
        if (command === 'INVITE' && params[1]) {
            return { title: config.name, body: `${nick} → ${params[1]}`, target: null, tag: `${TAG_PREFIX}invite`, sender: nick, channel: null };
        }
        return fallback;
    }

    const recipient = params[0] || '';
    const isChannel = /^[#&]/.test(recipient);
    const target = isChannel ? recipient : nick;
    let text = params[1] || '';
    let isAction = false;
    const ctcp = /^\x01(\S+)(?: (.*?))?\x01?$/.exec(text);
    if (ctcp) {
        if (ctcp[1].toUpperCase() !== 'ACTION') return fallback;
        isAction = true;
        text = ctcp[2] || '';
    }
    text = text.replace(FORMATTING_CODES, '').trim();

    return {
        title: isChannel ? `${nick} in ${recipient}` : nick,
        body: isAction ? `* ${nick} ${text}` : text,
        target,
        tag: `${TAG_PREFIX}${target.toLowerCase()}`,
        sender: nick,
        channel: isChannel ? recipient.toLowerCase() : null,
    };
}

function normalizeFilter(filter) {
    const lower = (list) => (Array.isArray(list) ? list : []).map((entry) => String(entry).toLowerCase()).slice(0, 500);
    return { muted: lower(filter?.muted), ignored: lower(filter?.ignored) };
}

let pushFilter = null;

/** Kept in the Cache API: the worker is stopped between pushes and loses its variables. */
async function loadFilter() {
    if (pushFilter) return pushFilter;
    try {
        const response = await (await self.caches.open(FILTER_CACHE)).match(FILTER_URL);
        pushFilter = normalizeFilter(response ? await response.json() : null);
    } catch {
        pushFilter = normalizeFilter(null);
    }
    return pushFilter;
}

async function saveFilter(filter) {
    pushFilter = normalizeFilter(filter);
    try {
        const cache = await self.caches.open(FILTER_CACHE);
        await cache.put(FILTER_URL, new Response(JSON.stringify(pushFilter), { headers: { 'Content-Type': 'application/json' } }));
    } catch {
        // no Cache API: the filter holds until the worker stops
    }
}

/** Mentions in a muted channel and anything from an ignored user. */
function isSuppressed(notification, filter) {
    if (notification.sender && filter.ignored.includes(notification.sender.toLowerCase())) return true;
    return Boolean(notification.channel) && filter.muted.includes(notification.channel);
}

function isChatWindow(client) {
    try {
        const path = new URL(client.url).pathname;
        return config.chatPaths.some((chatPath) => path === chatPath || path.startsWith(chatPath.endsWith('/') ? chatPath : `${chatPath}/`));
    } catch {
        return false;
    }
}

async function handlePush(event) {
    const line = event.data ? event.data.text() : '';
    const notification = buildPushNotification(line);
    // Chrome may show a generic notice for a silent push; rare, the server only pushes DMs and mentions
    if (isSuppressed(notification, await loadFilter())) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((client) => isChatWindow(client) && client.visibilityState === 'visible')) return;

    await self.registration.showNotification(notification.title, {
        body: notification.body,
        tag: notification.tag,
        renotify: true,
        icon: config.icon,
        data: { target: notification.target },
    });
}

async function handleNotificationClick(event) {
    event.notification.close();
    const target = event.notification.data?.target || null;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const chat = windows.find(isChatWindow);
    if (chat) {
        await chat.focus();
        if (target) chat.postMessage({ type: 'open-target', target });
        return;
    }
    const chatPath = config.chatPaths[0];
    await self.clients.openWindow(target ? `${chatPath}?open=${encodeURIComponent(target)}` : chatPath);
}

self.addEventListener('push', (event) => event.waitUntil(handlePush(event)));
self.addEventListener('notificationclick', (event) => event.waitUntil(handleNotificationClick(event)));
self.addEventListener('message', (event) => {
    if (event.data?.type === 'push-filter') event.waitUntil(saveFilter(event.data));
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
