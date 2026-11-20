/**
 * IRC over TCP through the app around the chat: bridge messages, registration, reconnect.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { nativeSocketConnector } from '../../src/core/native-socket.js';
import { saslPlain } from '../../src/core/irc-protocol.js';

let sent;
let listeners;
let ctx;

const bridge = {
    send: (type, data) => sent.push({ type, ...data }),
    listen: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};
const emit = (data) => [...listeners].forEach(listener => listener(data));
const connectNativeSocket = nativeSocketConnector(bridge);

function connect(options = {}) {
    ctx.socket = connectNativeSocket({
        irc: { host: 'irc.libera.chat', port: 6697, tls: true },
        nickname: 'alice',
        ctx,
        onMessage: () => {},
        quitMessage: 'bye',
        ...options,
    });
    return sent.find(message => message.type === 'native-socket-connect' && message.connectionId === ctx._activeNativeConnectionId);
}

const lines = () => sent.filter(message => message.type === 'native-socket-send' && message.line).map(message => message.line);

beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    listeners = new Set();
    ctx = { states: [], setConnectionState(state) { this.states.push(state); } };
});

afterEach(() => {
    vi.useRealTimers();
});

test('asks the app for a socket to host and port', () => {
    const request = connect();
    assert.equal(request.host, 'irc.libera.chat');
    assert.equal(request.port, 6697);
    assert.equal(request.ssl, true);
    assert.match(request.connectionId, /^native-/);
});

test('needs a host and a port', () => {
    assert.throws(() => connectNativeSocket({ irc: { host: '' }, nickname: 'a', ctx, onMessage() {} }), /irc.host/);
});

test('registers after open and hands the quit message to the app', () => {
    const { connectionId } = connect();
    emit({ connectionId, event: 'open' });
    assert.ok(sent.some(message => message.quitMessage === 'bye'));
    assert.ok(lines().some(line => line.startsWith('CAP LS')));
    assert.ok(lines().includes('NICK alice'));
});

test('server lines reach onMessage after registration, events of other sockets are ignored', () => {
    const received = [];
    const { connectionId } = connect({ onMessage: event => received.push(event.data) });
    emit({ connectionId, event: 'open' });
    emit({ connectionId, event: 'message', data: ':server CAP * LS :\r\n' });
    emit({ connectionId, event: 'message', data: ':server 001 alice :Welcome\r\n:bob!b@h PRIVMSG #x :hi\r\n' });
    emit({ connectionId: 'native-other', event: 'message', data: ':evil PRIVMSG #x :spoof' });
    assert.ok(received.some(line => line.includes('PRIVMSG #x :hi')));
    assert.ok(!received.some(line => line.includes('spoof')));
});

test('SASL PLAIN uses the account, not the nick', () => {
    const { connectionId } = connect({ sasl: saslPlain('account', 'secret') });
    emit({ connectionId, event: 'open' });
    emit({ connectionId, event: 'message', data: ':server CAP * LS :sasl' });
    emit({ connectionId, event: 'message', data: ':server CAP alice ACK :sasl' });
    emit({ connectionId, event: 'message', data: 'AUTHENTICATE +' });
    const payload = lines().find(line => line.startsWith('AUTHENTICATE ') && line !== 'AUTHENTICATE PLAIN');
    assert.equal(atob(payload.slice('AUTHENTICATE '.length)), 'account\0account\0secret');
});

test('a closed socket reconnects with backoff, a logout does not', () => {
    const statuses = [];
    const first = connect({ onStatusUpdate: status => statuses.push(status) });
    emit({ connectionId: first.connectionId, event: 'close' });
    assert.deepEqual(statuses, ['disconnected']);
    vi.advanceTimersByTime(3000);
    const second = sent.filter(message => message.type === 'native-socket-connect').at(-1);
    assert.notEqual(second.connectionId, first.connectionId);

    ctx.socket.close();
    assert.ok(sent.some(message => message.type === 'native-socket-close' && message.connectionId === second.connectionId));
    emit({ connectionId: second.connectionId, event: 'close' });
    vi.advanceTimersByTime(60000);
    assert.equal(sent.filter(message => message.type === 'native-socket-connect').length, 2);
});

test('resume starts a waiting reconnect right away', () => {
    const first = connect();
    emit({ connectionId: first.connectionId, event: 'close' });
    ctx.socket.resume();
    vi.advanceTimersByTime(0);
    assert.equal(sent.filter(message => message.type === 'native-socket-connect').length, 2);
});

test('quit says goodbye on an open socket and stops reconnecting', () => {
    const { connectionId } = connect();
    emit({ connectionId, event: 'open' });
    ctx.socket.quit();
    assert.ok(lines().includes('QUIT :bye'));
    assert.equal(ctx.performLogout, true);
});

test('lines are dropped while the socket is not open', () => {
    connect();
    ctx.socket.send('PRIVMSG #x :early');
    assert.ok(!lines().includes('PRIVMSG #x :early'));
});
