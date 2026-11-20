import { createProtocolHandler, nextReconnectDelay } from './irc-protocol.js';
import { DEFAULT_QUIT_MESSAGE } from './websocket.js';

/**
 * Plain IRC over TCP for apps around the chat that can open sockets (the desktop app).
 * The chat never touches the socket itself: it sends lines and receives events through a
 * bridge the app provides, e.g. postMessage to the parent frame.
 *
 * Bridge messages from the chat:
 *   native-socket-connect { connectionId, host, port, ssl }
 *   native-socket-send    { connectionId, line } or { connectionId, quitMessage }
 *   native-socket-close   { connectionId }
 * Events from the app (type native-socket-event):
 *   { connectionId, event: 'open' | 'message' | 'error' | 'close', data?, error? }
 *
 * @typedef {Object} NativeSocketBridge
 * @property {(type: string, data: Object) => void} send
 * @property {(listener: (data: Object) => void) => (() => void)} listen Native socket events;
 *   returns a function that stops listening.
 */

let connectionCounter = 0;

function newConnectionId() {
    connectionCounter += 1;
    return `native-${Date.now().toString(36)}-${connectionCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {NativeSocketBridge} bridge
 * @return {(options: Object) => Object} Same options and result as connectWebSocket(), with
 *   options.irc = { host, port, tls } instead of options.url.
 */
export function nativeSocketConnector(bridge) {
    function connectNativeSocket(options) {
        const { irc, nickname, sasl = null, ctx, onMessage, onStatusUpdate = () => {} } = options;
        const host = String(irc?.host || '');
        const port = Number(irc?.port || 0);
        if (!host || !port) {
            throw new Error('native socket needs irc.host and irc.port');
        }
        const ssl = irc.tls !== false;
        const connectionId = newConnectionId();
        const quitMessage = () => ctx.effectiveQuitMessage?.() || options.quitMessage || DEFAULT_QUIT_MESSAGE;
        let open = false;
        let closedByClient = false;

        clearTimeout(ctx._nativeReconnectTimer);
        ctx._nativeReconnectTimer = null;
        ctx._activeNativeConnectionId = connectionId;

        const send = (data) => bridge.send('native-socket-send', { connectionId, ...data });

        const protocol = createProtocolHandler({
            nickname,
            sasl,
            ctx,
            sendLine: (line) => send({ line }),
            closeTransport: () => bridge.send('native-socket-close', { connectionId }),
            onMessage,
        });

        function scheduleReconnect(delay) {
            clearTimeout(ctx._nativeReconnectTimer);
            ctx._nativeReconnectTimer = setTimeout(() => {
                ctx._nativeReconnectTimer = null;
                if (ctx.performLogout || ctx._activeNativeConnectionId !== connectionId) return;
                ctx.setConnectionState?.('connecting');
                if (!options.beforeReconnect) {
                    ctx.socket = connectNativeSocket(options);
                    return;
                }
                const replaced = ctx.socket;
                new Promise((resolve) => resolve(options.beforeReconnect()))
                    .catch((error) => console.warn('beforeReconnect failed, reconnecting with the old values:', error))
                    .then(() => {
                        if (!ctx.performLogout && ctx.socket === replaced) ctx.socket = connectNativeSocket(options);
                    });
            }, delay);
        }

        const stopListening = bridge.listen((data) => {
            if (data?.connectionId !== connectionId) return;
            switch (data.event) {
                case 'open':
                    open = true;
                    // The app quits the socket itself when it is closed, with this text
                    send({ quitMessage: quitMessage() });
                    protocol.onOpen();
                    return;
                case 'message': {
                    if (typeof data.data !== 'string') return;
                    const lines = data.data.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
                    for (const line of lines) protocol.onLine(line);
                    return;
                }
                case 'error':
                    console.error('Native socket error:', data.error);
                    onStatusUpdate('error');
                    return;
                case 'close':
                    open = false;
                    protocol.cleanup();
                    stopListening();
                    if (closedByClient || ctx._activeNativeConnectionId !== connectionId) return;
                    onStatusUpdate('disconnected');
                    if (!ctx.performLogout) scheduleReconnect(nextReconnectDelay(ctx));
                    return;
                default:
            }
        });

        bridge.send('native-socket-connect', { connectionId, host, port, ssl });

        return {
            send: (line) => {
                if (open) send({ line });
                else console.warn('Native socket not open, cannot send:', line);
            },
            /** Back in the foreground or online again: a waiting reconnect starts now. */
            resume: () => {
                if (ctx.performLogout || closedByClient || !ctx._nativeReconnectTimer) return;
                ctx._reconnectAttempt = 0;
                scheduleReconnect(0);
            },
            /** The page goes away: say goodbye, the app keeps the socket until the server closes it. */
            quit: () => {
                ctx.performLogout = true;
                clearTimeout(ctx._nativeReconnectTimer);
                if (open) send({ line: `QUIT :${quitMessage()}` });
            },
            setQuitMessage: (text) => send({ quitMessage: text }),
            close: () => {
                closedByClient = true;
                ctx.performLogout = true;
                clearTimeout(ctx._nativeReconnectTimer);
                ctx._nativeReconnectTimer = null;
                if (ctx._activeNativeConnectionId === connectionId) ctx._activeNativeConnectionId = null;
                try {
                    if (open) send({ line: `QUIT :${quitMessage()}` });
                } finally {
                    bridge.send('native-socket-close', { connectionId });
                    stopListening();
                    protocol.cleanup();
                }
            },
        };
    }

    return connectNativeSocket;
}
