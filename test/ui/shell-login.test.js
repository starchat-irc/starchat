/**
 * Logins the chat hands to the apps, so the next start logs in without the dialog.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createPlainStore } from '../../src/core/store.js';
import { createConnection } from '../../src/core/connection.js';
import { createTranslator } from '../../src/i18n/index.js';
import { createChatComponent } from '../../src/ui/component.js';
import { createChannelManagementState } from '../../src/ui/mixins/channel-management.js';
import { installBrowserStubs } from './chat-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

function chatIn(shell) {
    const host = [];
    const chat = createChatComponent({
        connection: createConnection({ server: { id: 'net', name: 'Net', websocket: 'wss://irc.example.org' } }),
        t: createTranslator({ locale: 'en' }),
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
    });
    chat.shell = shell;
    chat.notifyHost = (type, data) => host.push({ type, ...data });
    // Only the login is tested here, not the connection
    chat.connect = async () => {};
    return { chat, host };
}

test('mobile app: a SASL login from the dialog is handed over once the server let us in', async () => {
    const { chat, host } = chatIn('mobile');
    chat.loginUsername = 'kenobi';
    chat.loginPassword = 'hunter2';
    await chat.login();
    assert.deepEqual(host, [], 'nothing before the server accepted it');

    chat.saveShellSaslLogin();
    assert.deepEqual(host, [{ type: 'save-credentials', saslAccount: 'kenobi', saslPassword: 'hunter2' }]);
    chat.saveShellSaslLogin();
    assert.equal(host.length, 1, 'only once, not on every reconnect');
});

test('guests, token logins and the browser hand over no password', async () => {
    const guest = chatIn('mobile');
    guest.chat.loginUsername = 'kenobi';
    await guest.chat.guestLogin();
    guest.chat.saveShellSaslLogin();
    assert.deepEqual(guest.host, []);

    const token = chatIn('mobile');
    token.chat.loginUsername = 'kenobi';
    token.chat.loginPassword = 'hunter2';
    await token.chat.login();
    token.chat._apiLogin = { token: 'jwt' };
    token.chat.saveShellLogin();
    token.chat.saveShellSaslLogin();
    assert.deepEqual(token.host, [{ type: 'save-credentials', token: 'jwt', remember: false }], 'the token, never the password');

    const apiOnly = chatIn('mobile');
    apiOnly.chat.loginUsername = 'kenobi';
    apiOnly.chat.loginPassword = 'hunter2';
    await apiOnly.chat.login();
    apiOnly.chat._apiLogin = { token: 'api', apiOnly: true };
    apiOnly.chat.saveShellLogin();
    apiOnly.chat.saveShellSaslLogin();
    assert.deepEqual(apiOnly.host, [{ type: 'save-credentials', saslAccount: 'kenobi', saslPassword: 'hunter2' }],
        'api-login: the token cannot log in on IRC, so the app keeps the password');

    const web = chatIn(null);
    web.chat.loginUsername = 'kenobi';
    web.chat.loginPassword = 'hunter2';
    await web.chat.login();
    web.chat._apiLogin = { token: 'jwt' };
    web.chat.saveShellLogin();
    web.chat.saveShellSaslLogin();
    assert.deepEqual(web.host, []);
});
