/**
 * WebSocket transport and protocol handler: backoff after a close, the fast path
 * when an app returns to the foreground (resume), CAP and SASL.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { connectWebSocket } from '../../src/core/websocket.js';
import { saslBearer, saslPlain } from '../../src/core/irc-protocol.js';

const sockets = [];

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        sockets.push(this);
    }

    send(data) { this.sent.push(data); }
    close() { this.readyState = FakeWebSocket.CLOSED; }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    receive(line) { this.onmessage?.({ data: line }); }

    drop() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
}

let ctx;

function connect(options = {}) {
    ctx.socket = connectWebSocket({ url: 'wss://irc.test', nickname: 'alice', ctx, onMessage: () => {}, ...options });
    return sockets.at(-1);
}

beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx = {
        performLogout: false,
        states: [],
        setConnectionState(state, attempt = 0, delay = 0) { this.states.push({ state, attempt, delay }); },
    };
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

test('connects to the given URL and registers', () => {
    const socket = connect();
    socket.open();
    assert.equal(socket.url, 'wss://irc.test');
    assert.deepEqual(socket.sent, ['CAP LS 302\r\n', 'NICK alice\r\n', 'USER alice 0 * :alice\r\n']);
});

test('a dropped connection backs off exponentially', () => {
    connect().drop();
    assert.equal(ctx.states.at(-1).delay, 3000);
    vi.advanceTimersByTime(3000);
    assert.equal(sockets.length, 2);

    sockets[1].drop();
    assert.equal(ctx.states.at(-1).delay, 6000);
    vi.advanceTimersByTime(5999);
    assert.equal(sockets.length, 2, 'still waiting');
});

test('the backoff is capped at 30 seconds', () => {
    ctx._reconnectAttempt = 10;
    connect().drop();
    assert.equal(ctx.states.at(-1).delay, 30000);
});

test('resume skips a pending backoff and connects immediately', () => {
    ctx._reconnectAttempt = 4;
    connect().drop();
    assert.equal(ctx.states.at(-1).delay, 30000);

    ctx.socket.resume();
    vi.advanceTimersByTime(0);
    assert.equal(sockets.length, 2);
    assert.equal(ctx._reconnectAttempt, 0, 'the next failure starts the backoff from scratch');

    sockets[1].open();
    vi.advanceTimersByTime(30000);
    assert.equal(sockets.length, 2, 'the old timer is gone, no second socket');
});

test('resume probes an open socket and keeps it when the server answers', () => {
    const socket = connect();
    socket.open();

    ctx.socket.resume();
    assert.match(socket.sent.at(-1), /^PING :resume-\d+\r\n$/);
    socket.receive(':irc.test PONG irc.test :resume-1');
    vi.advanceTimersByTime(5000);

    assert.equal(sockets.length, 1);
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
});

test('resume replaces an open socket that stays silent', () => {
    const socket = connect();
    socket.open();

    ctx.socket.resume();
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(1); // fake timers run a 0 ms timeout created inside a tick 1 ms later

    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.equal(socket.onclose, null, 'the dead socket no longer schedules its own backoff');
    assert.ok(ctx.states.some((entry) => entry.state === 'reconnecting'));
    assert.equal(ctx.states.at(-1).state, 'connecting', 'the new socket is connecting');
    assert.equal(sockets.length, 2);
});

test('after the backoff the state switches to "connecting"', () => {
    connect().drop();
    assert.deepEqual(ctx.states.at(-1), { state: 'reconnecting', attempt: 1, delay: 3000 });
    vi.advanceTimersByTime(3000);
    assert.equal(ctx.states.at(-1).state, 'connecting');
});

test('a reconnect uses the same options', () => {
    connect({ url: 'wss://other.test' }).drop();
    vi.advanceTimersByTime(3000);
    assert.equal(sockets[1].url, 'wss://other.test');
});

test('a reconnect waits for beforeReconnect, e.g. a fresh token', async () => {
    let release;
    const beforeReconnect = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    connect({ beforeReconnect }).drop();
    vi.advanceTimersByTime(3000);
    assert.equal(beforeReconnect.mock.calls.length, 1);
    await Promise.resolve();
    assert.equal(sockets.length, 1, 'still waiting for the token');

    release();
    await vi.waitFor(() => assert.equal(sockets.length, 2));
});

test('a failing beforeReconnect still reconnects', async () => {
    connect({ beforeReconnect: () => Promise.reject(new Error('no parent')) }).drop();
    vi.advanceTimersByTime(3000);
    await vi.waitFor(() => assert.equal(sockets.length, 2));
});

test('a logout while beforeReconnect runs ends the reconnect', async () => {
    let release;
    connect({ beforeReconnect: () => new Promise((resolve) => { release = resolve; }) }).drop();
    vi.advanceTimersByTime(3000);
    ctx.performLogout = true;
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
});

test('a new login while beforeReconnect runs is not joined by a second socket', async () => {
    let release;
    connect({ beforeReconnect: () => new Promise((resolve) => { release = resolve; }) }).drop();
    vi.advanceTimersByTime(3000);
    ctx.socket = { replacedByLogin: true };
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
});

test('a handshake that hangs is given up and retried with backoff', () => {
    const socket = connect();
    vi.advanceTimersByTime(9999);
    assert.equal(sockets.length, 1, 'still waiting for the handshake');

    vi.advanceTimersByTime(1);
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.equal(socket.onclose, null, 'the hanging socket schedules no second backoff');
    assert.deepEqual(ctx.states.at(-1), { state: 'reconnecting', attempt: 1, delay: 3000 });

    vi.advanceTimersByTime(3000);
    assert.equal(sockets.length, 2);
});

test('an opened socket is not affected by the handshake timeout', () => {
    const socket = connect();
    socket.open();
    vi.advanceTimersByTime(60000);
    assert.equal(sockets.length, 1);
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
});

test('resume replaces a handshake still hanging from the background right away', () => {
    const socket = connect();
    ctx.socket.resume();
    vi.advanceTimersByTime(0);

    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
    assert.equal(sockets.length, 2);
    assert.equal(ctx._reconnectAttempt, 0);
    vi.advanceTimersByTime(10000);
    assert.deepEqual(ctx.states.at(-1), { state: 'reconnecting', attempt: 1, delay: 3000 },
        'only the new socket times out, the old one starts no backoff of its own');
    vi.advanceTimersByTime(3000);
    assert.equal(sockets.length, 3);
});

test('resume does nothing after a logout', () => {
    connect().drop();
    ctx.performLogout = true;
    ctx.socket.resume();
    vi.advanceTimersByTime(60000);
    assert.equal(sockets.length, 1);
});

test('closing the page sends a QUIT with the user\'s message and does not reconnect', () => {
    const socket = connect();
    socket.open();
    ctx.effectiveQuitMessage = () => 'Engage!';

    ctx.socket.quit();
    assert.equal(socket.sent.at(-1), 'QUIT :Engage!\r\n');

    socket.drop();
    vi.advanceTimersByTime(60000);
    assert.equal(sockets.length, 1, 'no reconnect after the goodbye');
});

test('without a user quit message the app default and then "Avoid staring into the cosmic void. It might stare back at you" is used', () => {
    const socket = connect({ quitMessage: 'Bye from the app' });
    socket.open();
    ctx.socket.quit();
    assert.equal(socket.sent.at(-1), 'QUIT :Bye from the app\r\n');

    ctx.performLogout = false;
    const plain = connect();
    plain.open();
    ctx.socket.quit();
    assert.equal(plain.sent.at(-1), 'QUIT :Avoid staring into the cosmic void. It might stare back at you.\r\n');
});

test('a socket closed by logout does not reconnect after the next login', () => {
    const socket = connect();
    socket.open();

    ctx.socket.close();
    ctx.performLogout = false; // login() right after the logout
    socket.drop();             // the browser reports the close later

    vi.advanceTimersByTime(60000);
    assert.equal(sockets.length, 1, 'no second connection next to the new one');
});

test('status updates use plain keys', () => {
    const statuses = [];
    const socket = connect({ onStatusUpdate: (status) => statuses.push(status) });
    socket.onerror?.(new Error('boom'));
    socket.drop();
    assert.deepEqual(statuses, ['error', 'disconnected']);
});

test('PING is answered before and after the registration', () => {
    const socket = connect();
    socket.open();
    socket.receive('PING :abc');
    assert.equal(socket.sent.at(-1), 'PONG :abc\r\n');
});

test('several lines in one frame are handled one by one', () => {
    const received = [];
    const socket = connect({ onMessage: (event) => received.push(event.data) });
    socket.open();
    socket.receive(':irc.test 001 alice :Welcome\r\n:irc.test 002 alice :Your host\r\n');
    assert.deepEqual(received, [':irc.test 001 alice :Welcome', ':irc.test 002 alice :Your host']);
});

// SASL

function connectWithLogin(sasl = saslBearer('alice', 'jwt-token')) {
    const socket = connect({ sasl });
    socket.open();
    return socket;
}

test('a login that gets no SASL answer reconnects instead of registering without the account', () => {
    const socket = connectWithLogin();
    socket.receive(':irc.test CAP * LS :sasl server-time');
    socket.receive(':irc.test CAP * ACK :sasl server-time');
    assert.equal(socket.sent.at(-1), 'AUTHENTICATE IRCV3BEARER\r\n');

    vi.advanceTimersByTime(5000);
    assert.equal(socket.readyState, FakeWebSocket.OPEN, 'a slow server gets more than 5 seconds');

    vi.advanceTimersByTime(15000);
    assert.ok(!socket.sent.includes('CAP END\r\n'), 'no unauthenticated registration (reserved nick, "alice_")');
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);

    socket.drop();
    assert.equal(ctx.states.at(-1).state, 'reconnecting');
});

test('a login on a server that stays silent after connecting also reconnects', () => {
    const socket = connectWithLogin();
    vi.advanceTimersByTime(20000);
    assert.ok(!socket.sent.includes('CAP END\r\n'));
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test('guests still register without capabilities when the server does not answer CAP', () => {
    const socket = connect();
    socket.open();
    vi.advanceTimersByTime(5000);
    assert.equal(socket.sent.at(-1), 'CAP END\r\n');
});

test('a SASL payload that fills the last chunk exactly is ended with "+"', () => {
    // "alice\0jwt\0" + token = 300 bytes, exactly 400 base64 characters
    const socket = connectWithLogin(saslBearer('alice', 'x'.repeat(290)));
    socket.receive(':irc.test CAP * LS :sasl');
    socket.receive(':irc.test CAP * ACK :sasl');
    socket.receive('AUTHENTICATE +');

    const authLines = socket.sent.filter((line) => line.startsWith('AUTHENTICATE ') && line !== 'AUTHENTICATE IRCV3BEARER\r\n');
    assert.equal(authLines.length, 2);
    assert.equal(authLines[0].trim().length, 'AUTHENTICATE '.length + 400);
    assert.equal(authLines[1], 'AUTHENTICATE +\r\n');
});

test('a shorter SASL payload is sent without the "+" terminator', () => {
    const socket = connectWithLogin();
    socket.receive(':irc.test CAP * LS :sasl');
    socket.receive(':irc.test CAP * ACK :sasl');
    socket.receive('AUTHENTICATE +');
    assert.ok(!socket.sent.includes('AUTHENTICATE +\r\n'));

    socket.receive(':irc.test 903 alice :SASL authentication successful');
    assert.equal(socket.sent.at(-1), 'CAP END\r\n');
});

test('the bearer token is read when the server asks for it', () => {
    let token = 'old';
    const socket = connectWithLogin(saslBearer('alice', () => token));
    socket.receive(':irc.test CAP * LS :sasl');
    socket.receive(':irc.test CAP * ACK :sasl');
    token = 'fresh';
    socket.receive('AUTHENTICATE +');
    const payload = socket.sent.at(-1).replace(/^AUTHENTICATE |\r\n$/g, '');
    assert.equal(atob(payload), 'alice\0jwt\0fresh');
});

test('SASL PLAIN sends the password as UTF-8', () => {
    const socket = connectWithLogin(saslPlain('jürgen', 'pässwört€'));
    socket.receive(':irc.test CAP * LS :sasl');
    socket.receive(':irc.test CAP * ACK :sasl');
    assert.equal(socket.sent.at(-1), 'AUTHENTICATE PLAIN\r\n');

    socket.receive('AUTHENTICATE +');
    const payload = socket.sent.at(-1).replace(/^AUTHENTICATE |\r\n$/g, '');
    const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
    assert.equal(new TextDecoder().decode(bytes), 'jürgen\0jürgen\0pässwört€');
});

test('a failed login is reported and the registration continues', () => {
    const failures = [];
    ctx.onSaslFailure = (numeric) => failures.push(numeric);
    const socket = connectWithLogin();
    socket.receive(':irc.test CAP * LS :sasl');
    socket.receive(':irc.test CAP * ACK :sasl');
    socket.receive(':irc.test 904 alice :SASL authentication failed');
    assert.deepEqual(failures, ['904']);
    assert.equal(socket.sent.at(-1), 'CAP END\r\n');
});

test('without a login the client does not request sasl', () => {
    const socket = connect();
    socket.open();
    socket.receive(':irc.test CAP * LS :sasl server-time');
    assert.equal(socket.sent.at(-1), 'CAP REQ :server-time\r\n');
});

test('a server without CAP support that registers right away is not ignored', () => {
    const received = [];
    const socket = connect({ onMessage: (event) => received.push(event.data) });
    socket.open();
    socket.receive(':irc.test 001 alice :Welcome');

    assert.deepEqual(received, [':irc.test 001 alice :Welcome']);
    vi.advanceTimersByTime(5000);
    assert.ok(!socket.sent.includes('CAP END\r\n'));
});

test('a server that does not know CAP (421) ends the negotiation', () => {
    const socket = connect();
    socket.open();
    socket.receive(':irc.test 421 * CAP :Unknown command');
    assert.equal(socket.sent.at(-1), 'CAP END\r\n');
});

// Capabilities

function capRequestAfter(...lsLines) {
    const socket = connect();
    socket.open();
    for (const line of lsLines) socket.receive(line);
    return socket.sent.find((line) => line.startsWith('CAP REQ')) || '';
}

test('a multiline CAP LS is collected before the request', () => {
    const request = capRequestAfter(
        ':irc.test CAP * LS * :batch server-time',
        ':irc.test CAP * LS :message-tags echo-message',
    );
    assert.equal(request, 'CAP REQ :batch message-tags server-time echo-message\r\n');
});

test('the negotiated capabilities are reported and stored on ctx', () => {
    let reported;
    ctx.onCapabilities = (caps) => { reported = caps; };
    capRequestAfter(':irc.test CAP * LS :server-time draft/multiline=max-bytes=8192,max-lines=50 chathistory foo');
    sockets.at(-1).receive(':irc.test CAP * ACK :server-time draft/multiline chathistory');

    assert.deepEqual(reported, {
        offered: ['chathistory', 'draft/multiline', 'foo', 'server-time'],
        enabled: ['chathistory', 'draft/multiline', 'server-time'],
    });
    assert.equal(ctx.supportsChathistory, true);
    assert.equal(ctx.supportsMultiline, true);
    assert.equal(ctx.multilineMaxBytes, 8192);
    assert.equal(ctx.multilineMaxLines, 50);
    assert.equal(sockets.at(-1).sent.at(-1), 'CAP END\r\n');
});

test('metadata-3 is preferred when the server offers both versions', () => {
    const request = capRequestAfter(':irc.test CAP * LS :draft/metadata-3=max-subs=100 draft/metadata-2=max-subs=100 batch');
    assert.match(request, /draft\/metadata-3/);
    assert.doesNotMatch(request, /draft\/metadata-2/);

    sockets.at(-1).receive(':irc.test CAP * ACK :draft/metadata-3 batch');
    assert.equal(ctx.metadataVersion, 3);
    assert.equal(ctx.supportsMetadata, true);
});

test('servers with only metadata-2 keep working with metadata-2', () => {
    const request = capRequestAfter(':irc.test CAP * LS :draft/metadata-2 batch');
    assert.match(request, /draft\/metadata-2/);

    sockets.at(-1).receive(':irc.test CAP * ACK :draft/metadata-2 batch');
    assert.equal(ctx.metadataVersion, 2);
    assert.equal(ctx.supportsMetadata, true);
});

test('servers without metadata are not asked for it', () => {
    assert.doesNotMatch(capRequestAfter(':irc.test CAP * LS :batch server-time'), /metadata/);
    sockets.at(-1).receive(':irc.test CAP * ACK :server-time');
    assert.equal(ctx.supportsMetadata, false);
    assert.equal(ctx.metadataVersion, 0);
});

test('a CAP NAK ends the negotiation', () => {
    capRequestAfter(':irc.test CAP * LS :batch');
    sockets.at(-1).receive(':irc.test CAP * NAK :batch');
    assert.equal(sockets.at(-1).sent.at(-1), 'CAP END\r\n');
});
