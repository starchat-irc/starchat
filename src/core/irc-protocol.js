/**
 * Connection setup on top of a line based transport: CAP negotiation, SASL,
 * registration and PING. WebSocket and native TCP share this handler.
 */

/** Wait for CAP replies before registering without capabilities. */
const CAP_NEGOTIATION_TIMEOUT_MS = 5000;
/** A login waits longer: slow mobile networks and server side lookups must not end in a guest registration. */
const SASL_NEGOTIATION_TIMEOUT_MS = 20000;
/** SASL payloads are sent in chunks of this size; a payload filling the last chunk exactly is ended with "+". */
export const SASL_CHUNK_SIZE = 400;

const readValue = (value) => (typeof value === 'function' ? value() : value);

/**
 * @typedef {Object} SaslMechanism
 * @property {string} mechanism Name sent with AUTHENTICATE.
 * @property {() => string} payload Unencoded payload, read when the server asks for it.
 */

/**
 * SASL PLAIN with account name and password.
 *
 * @param {string|(() => string)} username
 * @param {string|(() => string)} password
 * @return {SaslMechanism}
 */
export function saslPlain(username, password) {
    return {
        mechanism: 'PLAIN',
        payload: () => {
            const user = readValue(username);
            return `${user}\0${user}\0${readValue(password)}`;
        },
    };
}

/**
 * SASL IRCV3BEARER (draft/bearer) with a token. Account and token may be
 * functions so a token refreshed after the connect is used.
 *
 * @param {string|(() => string)} account
 * @param {string|(() => string)} token
 * @param {string} [type] Token type, e.g. "jwt" or "oauth2".
 * @return {SaslMechanism}
 */
export function saslBearer(account, token, type = 'jwt') {
    return {
        mechanism: 'IRCV3BEARER',
        payload: () => `${readValue(account)}\0${type}\0${readValue(token)}`,
    };
}

/**
 * Base64 of the UTF-8 bytes, as SASL requires. btoa() alone throws on characters
 * outside Latin-1 and encodes umlauts as single bytes.
 *
 * @param {string} text
 * @return {string}
 */
export function encodeSaslPayload(text) {
    let binary = '';
    for (const byte of new TextEncoder().encode(text)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/**
 * Advance the reconnect counter on ctx, publish the 'reconnecting' state and
 * return the backoff delay in ms (3s, 6s, 12s, ... capped at 30s).
 */
export function nextReconnectDelay(ctx) {
    const attempt = (ctx._reconnectAttempt || 0) + 1;
    ctx._reconnectAttempt = attempt;
    const delay = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
    ctx.setConnectionState?.('reconnecting', attempt, delay);
    return delay;
}

/**
 * @param {Object} options
 * @param {string} options.nickname
 * @param {SaslMechanism|null} [options.sasl] Log in with SASL; without it the client registers as a guest.
 * @param {Object} options.ctx Receives the negotiated capabilities (supportsChathistory, metadataVersion, ...)
 *   and optional callbacks: setConnectionState, onCapabilities({ offered, enabled }), onSaslFailure(numeric).
 * @param {(line: string) => void} options.sendLine
 * @param {() => void} options.closeTransport
 * @param {(event: { data: string }) => void} options.onMessage Lines after the registration.
 */
export function createProtocolHandler({
    nickname,
    sasl = null,
    ctx,
    sendLine,
    closeTransport,
    onMessage,
}) {
    let capNegotiationComplete = false;
    let registrationSent = false;
    let capRequested = false;
    let capTimeout = null;
    const offeredCaps = new Set();
    const capValues = {};
    const wantsSasl = !!sasl;

    function clearCapTimeout() {
        if (capTimeout) {
            clearTimeout(capTimeout);
            capTimeout = null;
        }
    }

    /**
     * A server that stays silent during CAP/SASL. Without a login the client simply
     * registers without capabilities. With a login, ending the negotiation would register
     * the user unauthenticated (the account nick is reserved then, 433 leads to "Nick_"),
     * so the connection is dropped instead and the normal reconnect tries again.
     */
    function startCapTimeout() {
        clearCapTimeout();
        capTimeout = setTimeout(() => {
            if (capNegotiationComplete) return;
            if (wantsSasl) {
                console.warn('CAP/SASL negotiation timeout, reconnecting instead of registering without login');
                capTimeout = null;
                closeTransport();
                return;
            }
            console.warn('CAP negotiation timeout, proceeding without capabilities');
            finishCapNegotiation();
        }, wantsSasl ? SASL_NEGOTIATION_TIMEOUT_MS : CAP_NEGOTIATION_TIMEOUT_MS);
    }

    function finishCapNegotiation() {
        if (capNegotiationComplete) return;
        clearCapTimeout();
        sendLine('CAP END');
        capNegotiationComplete = true;
    }

    function registerUser() {
        if (registrationSent) return;
        sendLine(`NICK ${nickname}`);
        sendLine(`USER ${nickname} 0 * :${nickname}`);
        registrationSent = true;
    }

    function onOpen() {
        ctx._reconnectAttempt = 0;
        ctx.setConnectionState?.('connecting');
        sendLine('CAP LS 302');
        registerUser();
        startCapTimeout();
    }

    function sendSaslPayload() {
        const auth = encodeSaslPayload(sasl.payload());
        for (let i = 0; i < auth.length; i += SASL_CHUNK_SIZE) {
            sendLine(`AUTHENTICATE ${auth.substring(i, i + SASL_CHUNK_SIZE)}`);
        }
        // Otherwise the server waits for more data and the login runs into the timeout
        if (auth.length % SASL_CHUNK_SIZE === 0) {
            sendLine('AUTHENTICATE +');
        }
    }

    function onLine(line) {
        const messageWithoutTags = line.startsWith('@') ? line.substring(line.indexOf(' ') + 1).trim() : line;
        const parts = messageWithoutTags.split(' ');

        if (!capNegotiationComplete && parts[1] === '421' && parts.length >= 4 && parts[3]?.toUpperCase() === 'CAP') {
            finishCapNegotiation();
            return;
        }

        if (!capNegotiationComplete && messageWithoutTags.startsWith(':') && messageWithoutTags.includes(' CAP ')) {
            clearCapTimeout();
            if (parts[3] === 'LS' && !capRequested) {
                const isMultiline = parts[4] === '*';
                const capsStartIndex = isMultiline ? 5 : 4;
                const capTokens = parts.slice(capsStartIndex).join(' ').replace(/^:/, '').trim().split(' ').filter(Boolean);
                capTokens.forEach((token) => {
                    const eqIndex = token.indexOf('=');
                    const name = eqIndex === -1 ? token : token.slice(0, eqIndex);
                    offeredCaps.add(name);
                    if (eqIndex !== -1) {
                        capValues[name] = token.slice(eqIndex + 1);
                    }
                });

                if (!isMultiline) {
                    const preferredMetadataCap = offeredCaps.has('draft/metadata-3')
                        ? 'draft/metadata-3'
                        : (offeredCaps.has('draft/metadata-2') ? 'draft/metadata-2' : null);
                    const preferredHistoryCap = offeredCaps.has('chathistory')
                        ? 'chathistory'
                        : (offeredCaps.has('draft/chathistory') ? 'draft/chathistory' : null);

                    const requestedCaps = [
                        'batch',
                        'away-notify',
                        'message-tags',
                        // Account of the sender on every message, so a nick alone is never trusted
                        'account-tag',
                        'server-time',
                        // Own messages come back with their msgid (needed to react to, reply to or delete them)
                        'echo-message',
                        'draft/message-redaction',
                        preferredHistoryCap,
                        // History replays JOIN/PART/QUIT/... as real events instead of service text
                        'draft/event-playback',
                        // metadata-3 (e.g. Ergo >= 2.19) when offered, otherwise metadata-2 (older Ergo, other servers)
                        preferredMetadataCap,
                        'draft/multiline',
                        // Read position shared by all sessions of the account
                        'draft/read-marker',
                        // Push for DMs and mentions while no client is connected (older Ergo: soju.im/webpush)
                        offeredCaps.has('draft/webpush') ? 'draft/webpush' : 'soju.im/webpush',
                        wantsSasl ? 'sasl' : null,
                    ].filter((cap) => cap && offeredCaps.has(cap));

                    if (requestedCaps.length > 0) {
                        sendLine(`CAP REQ :${requestedCaps.join(' ')}`);
                        capRequested = true;
                        startCapTimeout();
                    } else {
                        finishCapNegotiation();
                    }
                }
                return;
            }

            if (parts[3] === 'ACK') {
                const ackPayload = messageWithoutTags.includes(' ACK :') ? messageWithoutTags.split(' ACK :')[1] : '';
                const capsAck = ackPayload.split(' ').filter(Boolean).map((cap) => cap.split('=')[0]);
                const ackSet = new Set(capsAck);
                ctx.supportsChathistory = ackSet.has('chathistory') || ackSet.has('draft/chathistory');
                ctx.metadataVersion = ackSet.has('draft/metadata-3') ? 3 : (ackSet.has('draft/metadata-2') ? 2 : 0);
                ctx.supportsMetadata = ctx.metadataVersion > 0;
                ctx.supportsMessageTags = ackSet.has('message-tags');
                ctx.supportsEchoMessage = ackSet.has('echo-message');
                ctx.supportsRedaction = ackSet.has('draft/message-redaction');
                ctx.supportsReadMarker = ackSet.has('draft/read-marker');
                ctx.supportsWebpush = ackSet.has('draft/webpush') || ackSet.has('soju.im/webpush');

                ctx.supportsMultiline = ackSet.has('draft/multiline');
                if (ctx.supportsMultiline) {
                    const multilineParams = Object.fromEntries(
                        (capValues['draft/multiline'] || '').split(',').filter(Boolean).map((pair) => pair.split('='))
                    );
                    ctx.multilineMaxBytes = parseInt(multilineParams['max-bytes'], 10) || 4096;
                    ctx.multilineMaxLines = parseInt(multilineParams['max-lines'], 10) || 0;
                }

                ctx.onCapabilities?.({ offered: [...offeredCaps].sort(), enabled: [...ackSet].sort() });

                if (wantsSasl && ackSet.has('sasl')) {
                    sendLine(`AUTHENTICATE ${sasl.mechanism}`);
                    startCapTimeout();
                } else {
                    finishCapNegotiation();
                }
                return;
            }

            if (parts[3] === 'NAK') {
                finishCapNegotiation();
                return;
            }
        }

        if (wantsSasl && (messageWithoutTags === 'AUTHENTICATE :+' || messageWithoutTags === 'AUTHENTICATE +' || messageWithoutTags.includes(' AUTHENTICATE +'))) {
            sendSaslPayload();
            return;
        }

        if (wantsSasl && messageWithoutTags.startsWith(':') && (messageWithoutTags.includes(' 903 ') || messageWithoutTags.includes(' 904 ') || messageWithoutTags.includes(' 905 '))) {
            if (parts[1] !== '903') {
                console.warn(`SASL authentication failed (${parts[1]})`);
                ctx.onSaslFailure?.(parts[1]);
            }
            finishCapNegotiation();
            return;
        }

        if (messageWithoutTags.startsWith('PING')) {
            const pingValue = messageWithoutTags.split(':')[1];
            sendLine(`PONG :${pingValue}`);
            return;
        }

        // A server without CAP support registers right after NICK/USER
        if (!capNegotiationComplete && parts[1] === '001') {
            clearCapTimeout();
            capNegotiationComplete = true;
        }

        if (!capNegotiationComplete) return;
        onMessage({ data: line });
    }

    function cleanup() {
        clearCapTimeout();
    }

    return { onOpen, onLine, cleanup };
}
