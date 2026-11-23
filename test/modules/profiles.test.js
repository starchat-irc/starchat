/**
 * Token login over the API and the profiles module.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createConnection } from '../../src/core/connection.js';
import { createSettingsRegistry } from '../../src/ui/settings/registry.js';
import { normalizeProfile, profilesModule } from '../../src/modules/profiles.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { SERVER, apiStub, chatWith as baseChatWith, connectionWith, json, loggedInChat as baseLoggedInChat } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

const chatWith = (connection, { modules = [profilesModule] } = {}) => baseChatWith(connection, { modules });
const loggedInChat = (routes, options = {}) => baseLoggedInChat(routes, { modules: [profilesModule], ...options });

// Connection login

test('login stores the token and sends it with later API calls', async () => {
    const fetch = apiStub({ 'POST login': json({ token: 'jwt-1', nickname: 'Alice' }), 'GET chat/profile': json({}) });
    const connection = connectionWith(fetch);

    assert.equal(connection.tokenLogin(), 'bearer');
    assert.deepEqual(await connection.login('alice', 'secret'), { token: 'jwt-1', nickname: 'Alice' });
    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { username: 'alice', password: 'secret' });
    assert.equal(fetch.calls[0].init.credentials, 'omit');

    await connection.api('chat/profile');
    assert.equal(fetch.calls[1].init.headers.get('Authorization'), 'Bearer jwt-1');
});

test('wrong credentials give null, server errors throw', async () => {
    assert.equal(await connectionWith(apiStub({ 'POST login': json({ message: 'no' }, 401) })).login('a', 'b'), null);
    await assert.rejects(connectionWith(apiStub({ 'POST login': json({}, 500) })).login('a', 'b'));
    await assert.rejects(connectionWith(apiStub({ 'POST login': json({ nickname: 'x' }) })).login('a', 'b'));
});

test('token login needs bearer or api-login in auth and an API', () => {
    assert.equal(connectionWith(apiStub({}), { auth: ['sasl-plain'] }).tokenLogin(), null);
    assert.equal(connectionWith(apiStub({}), { auth: ['sasl-plain', 'api-login'] }).tokenLogin(), 'api');
    assert.equal(connectionWith(apiStub({}), { auth: ['api-login', 'bearer'] }).tokenLogin(), 'bearer', 'bearer wins');
    assert.equal(createConnection({ server: SERVER, discovery: { schemaVersion: 1, auth: ['bearer'] } }).tokenLogin(), null);
});

// Component login

test('a password on a server with bearer logs in over the API and uses the token on IRC', async () => {
    const fetch = apiStub({ 'POST login': json({ token: 'jwt-1', nickname: 'Alice' }) });
    const { chat, sockets } = chatWith(connectionWith(fetch));
    chat.loginUsername = 'alice';
    chat.loginPassword = 'secret';

    await chat.login();

    assert.equal(chat.nickname, 'Alice');
    assert.equal(chat.hasApiToken, true);
    assert.equal(chat.canUseProfiles(), true);
    assert.equal(sockets[0].options.sasl.mechanism, 'IRCV3BEARER');
});

test('wrong password at the API keeps the login dialog', async () => {
    const { chat, sockets } = chatWith(connectionWith(apiStub({ 'POST login': json({}, 401) })));
    chat.loginUsername = 'alice';
    chat.loginPassword = 'wrong';

    await chat.login();

    assert.equal(sockets.length, 0);
    assert.equal(chat.isAuthenticated, false);
    assert.equal(chat.loginError, chat.t('login_sasl_failed'));
});

test('an unreachable API falls back to SASL PLAIN without token', async () => {
    const { chat, sockets } = chatWith(connectionWith(apiStub({ 'POST login': new Error('offline') })));
    chat.loginUsername = 'alice';
    chat.loginPassword = 'secret';

    await chat.login();

    assert.equal(sockets[0].options.sasl.mechanism, 'PLAIN');
    assert.equal(chat.hasApiToken, false);
    assert.equal(chat.canUseProfiles(), false);
});

test('guests and servers without bearer get no token', async () => {
    const fetch = apiStub({});
    const { chat } = chatWith(connectionWith(fetch, { auth: ['sasl-plain'] }));
    chat.loginUsername = 'alice';
    chat.loginPassword = 'secret';
    await chat.login();
    assert.equal(fetch.calls.length, 0);
    assert.equal(chat.hasApiToken, false);

    const guest = chatWith(connectionWith(apiStub({}))).chat;
    await guest.guestLogin();
    assert.equal(guest.canUseProfiles(), false);
});

test('api-login: the token is only for the API, IRC keeps SASL PLAIN with the typed name', async () => {
    const fetch = apiStub({ 'POST login': json({ token: 'tok-1', nickname: 'Alice' }) });
    const { chat, sockets } = chatWith(connectionWith(fetch, { auth: ['sasl-plain', 'api-login'] }));
    chat.loginUsername = 'alice';
    chat.loginPassword = 'secret';

    await chat.login();

    assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { username: 'alice', password: 'secret' });
    assert.equal(chat.nickname, 'alice');
    assert.equal(chat.hasApiToken, true);
    assert.equal(chat.canUseProfiles(), true);
    assert.equal(sockets[0].options.sasl.mechanism, 'PLAIN');
    assert.equal(chat.connection.getToken(), 'tok-1');
});

test('api-login: a refused or unreachable API leaves the decision to the IRC server', async () => {
    for (const answer of [json({}, 401), new Error('offline')]) {
        const { chat, sockets } = chatWith(connectionWith(apiStub({ 'POST login': answer }), { auth: ['sasl-plain', 'api-login'] }));
        chat.loginUsername = 'alice';
        chat.loginPassword = 'secret';

        await chat.login();

        assert.equal(sockets[0].options.sasl.mechanism, 'PLAIN');
        assert.equal(chat.hasApiToken, false);
        assert.equal(chat.canUseProfiles(), false);
    }
});

// Profiles


test('the card loads the profile of the WHOIS account, not of the nick', async () => {
    const { chat, fetch } = await loggedInChat({
        'GET chat/profiles/bob%20b': json({ name: 'bob b', avatar_url: `${'https://home.example.org'}/a.png`, status: 'hi', member_since: '2024-01-02T00:00:00Z' }),
    });
    chat.profileCard.nick = 'Bobby';

    await chat.fetchProfileCard('Bobby', 'bob b');

    assert.equal(fetch.calls.at(-1).path, 'chat/profiles/bob%20b');
    assert.deepEqual(chat.profileCard.profile.characters, []);
    assert.deepEqual(chat.profileCard.profile.mutual_communities, []);
    assert.equal(chat.profileCardProfileAvatar(), 'https://home.example.org/a.png');
    assert.equal(chat.profileCard.loading, false);
});

test('a card that shows someone else meanwhile keeps its content', async () => {
    const { chat } = await loggedInChat({ 'GET chat/profiles/bob': json({ name: 'bob' }) });
    chat.profileCard.nick = 'Carol';
    await chat.fetchProfileCard('Bob', 'bob');
    assert.equal(chat.profileCard.profile, null);
});

test('avatars from another origin are not shown', async () => {
    const { chat } = await loggedInChat({ 'GET chat/profiles/bob': json({ name: 'bob', avatar_url: 'https://evil.test/a.png' }) });
    chat.profileCard.nick = 'Bob';
    await chat.fetchProfileCard('Bob', 'bob');
    assert.equal(chat.profileCardProfileAvatar(), '');
});

test('without the module the card loads nothing', async () => {
    const fetch = apiStub({ 'POST login': json({ token: 'jwt-1' }) });
    const { chat } = chatWith(connectionWith(fetch), { modules: [] });
    chat.loginUsername = 'alice';
    chat.loginPassword = 'secret';
    await chat.login();
    assert.equal(chat.hasFeature('profiles'), false);
    assert.equal(chat.fetchProfileCard, undefined);
    assert.equal(chat.canUseProfiles(), false);
});

test('own avatar and status are published after connect', async () => {
    const { chat, sent } = await loggedInChat({
        'GET chat/profile': json({ name: 'alice', avatar_url: 'https://home.example.org/me.png', status: 'busy\nnow' }),
    });

    await chat.loadOwnAvatar();

    assert.equal(chat.ownAvatarUrl, 'https://home.example.org/me.png');
    assert.equal(chat.ownStatus, 'busy now');
    assert.ok(sent.includes('METADATA * SET avatar :https://home.example.org/me.png'));
    assert.ok(sent.includes('METADATA * SET status :busy now'));
});

test('saving the status calls the API and publishes the new value', async () => {
    const { chat, fetch, sent } = await loggedInChat({
        'PUT chat/profile/status': (init) => json({ status: JSON.parse(init.body).status }),
    });
    chat.profileEditor.statusDraft = '  coffee  ';

    await chat.saveProfileStatus();

    assert.deepEqual(JSON.parse(fetch.calls.at(-1).init.body), { status: 'coffee' });
    assert.equal(chat.ownStatus, 'coffee');
    assert.ok(sent.includes('METADATA * SET status :coffee'));
    assert.equal(chat.profileEditor.statusNotice, chat.t('profile_status_saved'));

    await chat.saveProfileStatus(true);
    assert.deepEqual(JSON.parse(fetch.calls.at(-1).init.body), { status: null });
    assert.equal(chat.ownStatus, '');
    assert.ok(sent.includes('METADATA * SET status'));
});

test('validation errors of the API are shown', async () => {
    const { chat } = await loggedInChat({
        'DELETE chat/profile/avatar': json({ message: 'x', errors: { avatar: ['Too big'] } }, 422),
    });
    await chat.removeProfileAvatar();
    assert.equal(chat.profileEditor.error, 'Too big');
    assert.equal(chat.profileEditor.saving, false);
});

test('the account section opens the profile editor and only with a token', async () => {
    const { chat } = await loggedInChat({ 'GET chat/profile': json({ name: 'alice', status: 'away' }) });
    const registry = createSettingsRegistry();
    profilesModule.register(registry);

    const env = (hasAccount) => ({ shell: null, hasFeature: () => true, hasAccount });
    assert.deepEqual(registry.sectionsFor(env(true)).map(section => section.id), ['account']);
    assert.deepEqual(registry.sectionsFor(env(false)), []);

    chat.callModuleHook('settingsSectionOpened', 'account');
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(chat.profileEditor.show, true);
    assert.equal(chat.profileEditor.profile.name, 'alice');
    assert.equal(chat.profileEditor.statusDraft, 'away');

    chat.callModuleHook('settingsSectionClosed', 'account');
    assert.equal(chat.profileEditor.show, false);
});

test('normalizeProfile fills the optional lists', () => {
    assert.equal(normalizeProfile(null), null);
    assert.deepEqual(normalizeProfile({ name: 'a', characters: 'x' }), { name: 'a', characters: [], mutual_communities: [] });
});
