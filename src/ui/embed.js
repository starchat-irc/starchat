/**
 * Login through the page that embeds the chat in an iframe. The chat asks its parent
 * window for a token with { type: 'get-token' }; the parent answers with
 * { type: 'token-response', token, account?, nickname?, tokenType? }. The token is sent to the
 * primary server with SASL IRCV3BEARER, the server checks it.
 */

/** How long the chat waits for the parent before it shows the login dialog. */
export const PARENT_TOKEN_TIMEOUT_MS = 10000;

/**
 * @typedef {Object} BearerLogin
 * @property {string} token
 * @property {string} [account] Sent as authorization identity, empty lets the server take it from the token.
 * @property {string} [nickname] Nick for the registration; without it the account or a guest nick.
 * @property {string} [tokenType] Token type, "jwt" when left out.
 */

/**
 * @param {string} origin
 * @return {string}
 */
function normalizeOrigin(origin) {
    const value = String(origin || '').trim();
    if (value === '*' || value === 'null') {
        throw new Error(`bearerFromParent: "${value}" is not allowed, list the parent origins`);
    }
    const url = new URL(value);
    if (url.origin === 'null' || url.origin !== value.replace(/\/$/, '')) {
        throw new Error(`bearerFromParent: "${value}" is not an origin like https://example.org`);
    }
    return url.origin;
}

/**
 * @param {*} data
 * @return {BearerLogin|null}
 */
export function readBearerLogin(data) {
    const token = typeof data?.token === 'string' ? data.token.trim() : '';
    if (!token) return null;
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    return {
        token,
        account: text(data.account),
        nickname: text(data.nickname),
        tokenType: text(data.tokenType) || 'jwt',
    };
}

/**
 * Token source for mountChat({ bearer }) that asks the parent window. Answers are only
 * taken from the direct parent and from the listed origins (plus the chat's own origin).
 * Each call asks again, so a reconnect gets a fresh token.
 *
 * @param {Object} [options]
 * @param {string[]} [options.allowedOrigins] Origins of the pages that may embed the chat and log in.
 * @param {number} [options.timeout] ms until the call gives up and resolves with null.
 * @param {Window} [options.window]
 * @return {() => Promise<BearerLogin|null>}
 */
export function bearerFromParent({ allowedOrigins = [], timeout = PARENT_TOKEN_TIMEOUT_MS, window: win = globalThis.window } = {}) {
    const origins = new Set([win.location.origin, ...allowedOrigins.map(normalizeOrigin)]);

    return () => new Promise((resolve) => {
        const parent = win.parent;
        if (!parent || parent === win) {
            resolve(null);
            return;
        }

        const finish = (value) => {
            clearTimeout(timer);
            win.removeEventListener('message', onMessage);
            resolve(value);
        };
        const onMessage = (event) => {
            if (event.source !== parent || !origins.has(event.origin)) return;
            if (event.data?.type !== 'token-response' && event.data?.type !== 'token') return;
            finish(readBearerLogin(event.data));
        };
        const timer = setTimeout(() => finish(null), timeout);
        win.addEventListener('message', onMessage);

        // Addressed to each allowed origin: a parent from anywhere else does not even get the request.
        for (const origin of origins) {
            parent.postMessage({ type: 'get-token' }, origin);
        }
    });
}
