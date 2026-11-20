/**
 * Settings -> Connections (desktop): drafts, what is sent to the app and the
 * request/response bridge.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { connectionsMixin, connectionDraft, connectionPayload, connectionsModule, describeServer } from '../../src/modules/connections.js';
import { settingsRegistry } from '../../src/ui/settings/registry.js';

const posted = [];

function createPage() {
    const page = connectionsMixin();
    // Every key counts as translated: «key»
    page.t = (key, replacements = {}) => Object.entries(replacements).reduce((text, [name, value]) => text.replace(`:${name}`, value), `«${key}»`);
    page.closeSettings = () => {};
    page.shell = 'desktop';
    page.notifyHost = (type, data = {}) => posted.push({ type, ...data });
    return page;
}

/** Answer the last request the page sent to the shell. */
function answer(page, result) {
    const request = posted.at(-1);
    page.handleConnectionsResponse({ id: request.id, result });
    return request;
}

let page;
beforeEach(() => {
    posted.length = 0;
    page = createPage();
});

test('the payload holds only editable fields, a password only when one was entered', () => {
    const draft = connectionDraft({
        hash: 'ext-1', name: 'Libera', serverType: 'external', hasSaslPassword: true, summary: 'x',
        externalServer: { host: 'irc.libera.chat', port: '6697', ssl: true, nickname: 'kenobi' },
    });

    const payload = connectionPayload(draft);
    assert.deepEqual(Object.keys(payload).sort(), ['externalServer', 'hash', 'name', 'serverType']);
    assert.equal(payload.externalServer.port, 6697);
    assert.equal(payload.saslPassword, undefined);
    assert.equal(connectionPayload(draft, 'hunter2').saslPassword, 'hunter2');
});

test('a new connection is sent without an id', () => {
    const payload = connectionPayload(connectionDraft(null, 'home'));
    assert.equal(payload.hash, undefined);
    assert.equal(payload.serverType, 'home');
});

test('loading asks the shell and shows the list', async () => {
    const loading = page.loadConnections();
    const request = answer(page, { ok: true, profiles: [{ hash: 'home-1', serverType: 'home', name: 'Obi_Wan' }], current: 'home-1', homeName: 'irc.example.org' });
    await loading;

    assert.equal(request.type, 'connections-request');
    assert.equal(request.action, 'list');
    assert.equal(page.connectionsPage.available, true);
    assert.equal(page.connectionsPage.view, 'list');
    assert.equal(page.connectionsPage.profiles.length, 1);
    assert.equal(page.currentConnectionHash(), 'home-1');
    assert.equal(page.connectionTitle({ serverType: 'home' }), 'irc.example.org');
});

test('saving shows the errors of the main process next to the fields', async () => {
    page.startNewConnection('external');
    page.connectionsPage.draft.externalServer.host = 'ircs://bad';

    const saving = page.saveConnection();
    const request = answer(page, { ok: false, errors: { host: 'connection_error_host_invalid' } });
    await saving;

    assert.equal(request.action, 'save');
    assert.equal(page.connectionError('host'), '«connection_error_host_invalid»');
    assert.equal(page.connectionsPage.view, 'new', 'stays in the form');
});

test('after saving, the password field is empty again and only "saved" is shown', async () => {
    page.startNewConnection('home');
    page.connectionsPage.password = 'hunter2';

    const saving = page.saveConnection();
    const request = answer(page, {
        ok: true,
        profile: { hash: 'new-1', serverType: 'home', name: null, hasSaslPassword: true },
        profiles: [{ hash: 'new-1', serverType: 'home', hasSaslPassword: true }],
    });
    await saving;

    assert.equal(request.payload.saslPassword, 'hunter2');
    assert.equal(page.connectionsPage.password, '');
    assert.equal(page.connectionsPage.view, 'edit');
    assert.equal(page.connectionsPage.draft.hash, 'new-1');
    assert.equal(page.connectionsPage.draft.hasSaslPassword, true);
    assert.equal(page.isConnectionDirty(), false);
});

test('deleting asks for confirmation first', async () => {
    page.connectionsPage.profiles = [{ hash: 'a', serverType: 'home' }, { hash: 'b', serverType: 'home' }];
    page.editConnection('b');

    await page.deleteConnection();
    assert.equal(posted.length, 0, 'first click only arms the button');
    assert.equal(page.connectionsPage.deleteConfirm, true);

    const deleting = page.deleteConnection();
    const request = answer(page, { ok: true, profiles: [{ hash: 'a', serverType: 'home' }] });
    await deleting;

    assert.deepEqual(request.payload, { hash: 'b' });
    assert.equal(page.connectionsPage.view, 'list');
    assert.equal(page.connectionsPage.profiles.length, 1);
});

test('a refused connection test shows the reason', async () => {
    page.startNewConnection('external');
    page.connectionsPage.draft.externalServer.host = 'irc.example.org';

    const testing = page.testConnectionDraft();
    answer(page, { ok: false, reason: 'rate_limited' });
    await testing;

    assert.equal(page.connectionTestMessage(), '«connections_test_rate_limited»');
});

test('answers with an unknown id are ignored', () => {
    assert.doesNotThrow(() => page.handleConnectionsResponse({ id: 'unknown', result: { ok: true } }));
});

test('a directory server becomes a new external draft', () => {
    page.startConnectionFromServer({ name: 'Libera.Chat', host: 'irc.libera.chat', port: 6697, ssl: true, default_channel: '#libera' });

    assert.equal(page.connectionsPage.view, 'new');
    assert.equal(page.connectionsPage.draft.name, 'Libera.Chat');
    assert.equal(page.connectionsPage.draft.externalServer.defaultChannel, '#libera');
    assert.equal(describeServer(page.connectionsPage.draft.externalServer), 'irc.libera.chat:6697 (TLS)');
});

test('outside the desktop app there is no connections API', async () => {
    page.shell = null;
    assert.deepEqual(await page.connectionsRequest('list'), { ok: false, reason: 'unavailable' });
    assert.equal(posted.length, 0);
});

test('answers and change notices arrive through the shellMessage hook', async () => {
    const loading = page.loadConnections();
    const request = posted.at(-1);
    connectionsModule.hooks.shellMessage.call(page, 'connections-response', { id: request.id, result: { ok: true, profiles: [] } });
    await loading;
    assert.equal(page.connectionsPage.available, true);

    connectionsModule.hooks.shellMessage.call(page, 'connections-changed', {});
    assert.equal(posted.at(-1).action, 'list', 'reloads the list');
});

test('the page is a settings section of the desktop app that loads when opened', () => {
    connectionsModule.register(settingsRegistry);
    const ids = env => settingsRegistry.sectionsFor(env).map(section => section.id);
    assert.ok(ids({ shell: 'desktop', connectionsApi: true }).includes('connections'));
    assert.ok(!ids({ shell: 'desktop', connectionsApi: false }).includes('connections'), 'only when the app answers');
    assert.ok(!ids({ shell: null, connectionsApi: true }).includes('connections'));

    connectionsModule.hooks.settingsSectionOpened.call(page, 'connections');
    assert.equal(posted.at(-1).action, 'list');
});
