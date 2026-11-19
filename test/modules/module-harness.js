/**
 * Helpers for module tests: a fetch stub for the API and a chat component on a
 * connection with discovery.
 */
import { createPlainStore } from '../../src/core/store.js';
import { createConnection } from '../../src/core/connection.js';
import { createTranslator } from '../../src/i18n/index.js';
import { createChatComponent } from '../../src/ui/component.js';
import { createChannelManagementState } from '../../src/ui/mixins/channel-management.js';

export const SERVER = { id: 'home', name: 'Home Net', domain: 'home.example.org', languages: ['en'], websocket: 'wss://home.example.org/ws' };
export const API = 'https://home.example.org/api';

export const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** fetch stub answering by "METHOD path" (path relative to the API), recording every call. */
export function apiStub(routes) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const method = init.method || 'GET';
        const path = url.slice(API.length + 1);
        calls.push({ method, path, init });
        const answer = routes[`${method} ${path}`];
        if (answer instanceof Error) throw answer;
        if (!answer) return json({ message: 'not found' }, 404);
        return typeof answer === 'function' ? answer(init) : answer;
    };
    fn.calls = calls;
    return fn;
}

export function connectionWith(fetch, { auth = ['sasl-plain', 'bearer', 'guest'], features = ['profiles'], links = {} } = {}) {
    return createConnection({
        server: SERVER,
        discovery: { schemaVersion: 1, apiBaseUrl: API, auth, features, links },
        fetch,
    });
}

export function chatWith(connection, { modules = [] } = {}) {
    const sockets = [];
    const sent = [];
    const chat = createChatComponent({
        connection,
        modules,
        t: createTranslator({ locale: 'en' }),
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
        connectSocket: (options) => {
            const socket = { options, send: (line) => sent.push(line), close() {}, quit() {} };
            sockets.push(socket);
            return socket;
        },
    });
    chat.$nextTick = (callback) => callback?.();
    chat.$refs = {};
    chat.positionUserMenu = () => {};
    return { chat, sockets, sent };
}

/** As after registration: socket up, metadata supported. */
export function registered(chat) {
    chat.isRegistered = true;
    chat.connectionState = 'connected';
    chat.supportsMetadata = true;
}

/** Password login over the API (token jwt-1), then registered. */
export async function loggedInChat(routes, { modules, ...options } = {}) {
    const fetch = apiStub({ 'POST login': json({ token: 'jwt-1' }), ...routes });
    const result = chatWith(connectionWith(fetch, options), { modules });
    result.chat.loginUsername = 'alice';
    result.chat.loginPassword = 'secret';
    await result.chat.login();
    registered(result.chat);
    result.fetch = fetch;
    return result;
}
