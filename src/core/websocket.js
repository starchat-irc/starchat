import { createProtocolHandler, nextReconnectDelay } from './irc-protocol.js';

/** Sent on QUIT when neither the user nor the embedding app set a message. */
export const DEFAULT_QUIT_MESSAGE = 'Avoid staring into the cosmic void. It might stare back at you.';

/** How long a resumed app waits for any server line after its PING before it treats the socket as dead. */
const RESUME_PROBE_TIMEOUT_MS = 5000;
/**
 * A WebSocket handshake has no timeout of its own: on a network that is still waking up it can
 * hang for a minute. Give up after this long and try again with a fresh socket.
 */
const CONNECT_TIMEOUT_MS = 10000;

/**
 * Open an IRC connection over a WebSocket (IRCv3 WebSocket, text frames, one or more
 * lines per frame). Reconnects with backoff until close() or quit() is called; the
 * replacement connection is stored in ctx.socket.
 *
 * @param {Object} options
 * @param {string} options.url wss:// URL of the server.
 * @param {string} options.nickname
 * @param {import('./irc-protocol.js').SaslMechanism|null} [options.sasl]
 * @param {Object} options.ctx Shared connection state, see createProtocolHandler(). Optional
 *   ctx.effectiveQuitMessage() returns the user's quit message.
 * @param {(event: { data: string }) => void} options.onMessage
 * @param {(status: 'disconnected'|'error') => void} [options.onStatusUpdate]
 * @param {string} [options.quitMessage] Default quit message of the embedding app.
 */
export function connectWebSocket(options) {
    const { url, nickname, sasl = null, ctx, onMessage, onStatusUpdate = () => {} } = options;
    const socket = new WebSocket(url);
    let lastReceivedAt = 0;
    const quitMessage = () => ctx.effectiveQuitMessage?.() || options.quitMessage || DEFAULT_QUIT_MESSAGE;
    let probeTimerId = null;
    let closedByClient = false;
    let connectTimerId = setTimeout(() => {
        connectTimerId = null;
        if (socket.readyState !== WebSocket.CONNECTING || closedByClient || ctx.performLogout) return;
        console.warn('WebSocket handshake timeout, trying a new connection');
        detach();
        scheduleReconnect(nextReconnectDelay(ctx));
    }, CONNECT_TIMEOUT_MS);

    const protocol = createProtocolHandler({
        nickname,
        sasl,
        ctx,
        sendLine: (line) => socket.send(`${line}\r\n`),
        closeTransport: () => socket.close(),
        onMessage,
    });

    /** Replace this socket after `delay` ms, one pending reconnect at a time. */
    function scheduleReconnect(delay) {
        if (ctx._wsReconnectTimer) clearTimeout(ctx._wsReconnectTimer);
        ctx._wsReconnectTimer = setTimeout(() => {
            ctx._wsReconnectTimer = null;
            if (!ctx.performLogout) {
                // The countdown is over: "connecting" until the socket opens or fails
                ctx.setConnectionState?.('connecting');
                ctx.socket = connectWebSocket(options);
            }
        }, delay);
    }

    /** Forget this socket: no more events from it, no backoff of its own. */
    function detach() {
        clearTimeout(connectTimerId);
        clearTimeout(probeTimerId);
        socket.onmessage = socket.onopen = socket.onerror = socket.onclose = null;
        protocol.cleanup();
        try { socket.close(); } catch { /* already gone */ }
        onStatusUpdate('disconnected');
    }

    /** Drop a socket that looks open but is dead (app slept, network changed) and connect again right away. */
    function abandonAndReconnect() {
        detach();
        ctx._reconnectAttempt = 0;
        ctx.setConnectionState?.('reconnecting', 1, 0);
        scheduleReconnect(0);
    }

    socket.onmessage = (event) => {
        lastReceivedAt = Date.now();
        const lines = String(event.data || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) protocol.onLine(line);
    };

    socket.onopen = () => {
        clearTimeout(connectTimerId);
        protocol.onOpen();
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        onStatusUpdate('error');
    };

    socket.onclose = () => {
        clearTimeout(probeTimerId);
        clearTimeout(connectTimerId);
        protocol.cleanup();
        // Closed on purpose (logout): a login right after it has its own socket already,
        // this one must not come back as a second connection.
        if (closedByClient) return;
        onStatusUpdate('disconnected');
        if (!ctx.performLogout) {
            scheduleReconnect(nextReconnectDelay(ctx));
        }
    };

    return {
        send: (msg) => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(`${msg}\r\n`);
            } else {
                console.warn('WebSocket not open, cannot send:', msg);
            }
        },
        /**
         * The app came back to the foreground or the network is back. A reconnect waiting in the
         * backoff starts immediately, a handshake still hanging from the background is replaced
         * by a fresh one, and an open socket is probed with a PING and replaced when the server
         * stays silent.
         */
        resume: () => {
            if (ctx.performLogout || closedByClient) return;
            if (ctx._wsReconnectTimer) {
                ctx._reconnectAttempt = 0;
                scheduleReconnect(0);
                return;
            }
            if (socket.readyState === WebSocket.CONNECTING) {
                abandonAndReconnect();
                return;
            }
            if (socket.readyState !== WebSocket.OPEN) return;
            const probeStartedAt = Date.now();
            clearTimeout(probeTimerId);
            socket.send(`PING :resume-${probeStartedAt}\r\n`);
            probeTimerId = setTimeout(() => {
                if (lastReceivedAt < probeStartedAt && socket.readyState === WebSocket.OPEN && !ctx.performLogout) {
                    abandonAndReconnect();
                }
            }, RESUME_PROBE_TIMEOUT_MS);
        },
        /** The page goes away (tab or window closed): say goodbye, the server closes the connection. */
        quit: () => {
            ctx.performLogout = true;
            clearTimeout(ctx._wsReconnectTimer);
            try {
                if (socket.readyState === WebSocket.OPEN) socket.send(`QUIT :${quitMessage()}\r\n`);
            } catch {
                // page is unloading, nothing left to do
            }
        },
        close: () => {
            closedByClient = true;
            clearTimeout(connectTimerId);
            clearTimeout(ctx._wsReconnectTimer);
            ctx._wsReconnectTimer = null;
            try {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(`QUIT :${quitMessage()}\r\n`);
                    setTimeout(() => socket.close(), 100);
                } else {
                    socket.close();
                }
            } catch (error) {
                console.error('Error closing WebSocket:', error);
                socket.close();
            } finally {
                ctx.performLogout = true;
            }
        },
    };
}
