import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createPlainStore } from '../../src/core/store.js';
import { createTranslator } from '../../src/i18n/index.js';
import { createChatComponent } from '../../src/ui/component.js';
import { createChannelManagementState } from '../../src/ui/mixins/channel-management.js';
import { FULL_LAYOUT, HEADLESS_LAYOUT, resolveLayout } from '../../src/ui/layout.js';
import { createSettingsRegistry } from '../../src/ui/settings/registry.js';
import { registerBuiltinSettings } from '../../src/ui/settings/definitions.js';
import { renderTemplate } from '../../src/ui/templates.js';
import { installBrowserStubs } from './chat-harness.js';

const t = createTranslator({ locale: 'en' });
const now = Date.now();

const LOBBY_MESSAGES = [
    { id: 1, user: 'alice', message: 'hello', _ts: now - 3000 },
    { id: 2, user: 'bob', isJoinPart: true, joinPartType: 'join', _ts: now - 2000 },
    { id: 3, user: 'bob', message: 'hi', _ts: now - 1000 },
];

function createComponent(layout) {
    const chat = createChatComponent({
        connection: { server: { id: 'test' }, hasFeature: () => false, websocketUrl: 'wss://irc.example.org' },
        t,
        layout,
        defaultChannel: '#lobby',
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
    });
    // The message manager starts with an empty store, so the lines go in afterwards
    chat.stores.messages.set({ '#lobby': { content: LOBBY_MESSAGES } });
    return chat;
}

function keydown(key, extra = {}) {
    const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, prevented: false, ...extra };
    event.preventDefault = () => { event.prevented = true; };
    return event;
}

function joinRowCount(chat) {
    return chat.messageRows.filter(row => row.type === 'events' || row.message?.isJoinPart).length;
}

beforeEach(() => {
    installBrowserStubs();
});

test('without the option everything is shown', () => {
    assert.deepEqual(resolveLayout(undefined), FULL_LAYOUT);
    assert.deepEqual(resolveLayout(null), FULL_LAYOUT);
    assert.deepEqual(resolveLayout('full'), FULL_LAYOUT);
});

test('headless switches every part off', () => {
    assert.deepEqual(resolveLayout('headless'), HEADLESS_LAYOUT);
    assert.ok(Object.values(HEADLESS_LAYOUT).every(value => value === false));
});

test('an object switches single parts off and keeps the rest', () => {
    const layout = resolveLayout({ userList: false, joinPart: 0, unknown: false });
    assert.deepEqual(layout, { ...FULL_LAYOUT, userList: false, joinPart: false });
});

test('an unknown preset is rejected', () => {
    assert.throws(() => resolveLayout('minimal'), /unknown layout "minimal"/);
});

test('the user list stays hidden without the part, even when the user opened it', () => {
    assert.equal(createComponent().showUserList, true);
    const chat = createComponent({ userList: false });
    chat.userListOpen = true;
    assert.equal(chat.showUserList, false);
});

test('join and part lines are left out without the part, whatever the stored preference says', () => {
    const full = createComponent();
    full.hideJoinPart = false;
    assert.equal(joinRowCount(full), 1);

    const headless = createComponent('headless');
    headless.hideJoinPart = false;
    assert.equal(joinRowCount(headless), 0);
    assert.equal(headless.messageRows.filter(row => row.message).length, 2);
});

test('a headless chat leaves the keys of the page alone', () => {
    const chat = createComponent('headless');
    for (const event of [
        keydown('p', { ctrlKey: true }),
        keydown('f', { ctrlKey: true }),
        keydown('?'),
        keydown('ArrowDown', { altKey: true }),
    ]) {
        chat.handleGlobalKeydown(event);
        assert.equal(event.prevented, false, event.key);
    }
    assert.equal(chat.quickSwitcher.show, false);
    assert.equal(chat.showShortcutHelp, false);
});

test('without channel list and header the switching and search keys are off, the rest stays', () => {
    const chat = createComponent({ channelList: false, header: false });
    const switcher = keydown('p', { ctrlKey: true });
    chat.handleGlobalKeydown(switcher);
    assert.equal(switcher.prevented, false);
    assert.equal(chat.quickSwitcher.show, false);

    const search = keydown('f', { ctrlKey: true });
    chat.handleGlobalKeydown(search);
    assert.equal(search.prevented, false);

    chat.handleGlobalKeydown(keydown('?'));
    assert.equal(chat.showShortcutHelp, true);
});

test('settings for hidden parts are not offered', () => {
    const registry = createSettingsRegistry();
    registerBuiltinSettings(registry);
    const ids = (layout) => registry.settingsFor('appearance', { shell: null, layout, hasFeature: () => false })
        .map(setting => setting.id);

    assert.ok(ids(FULL_LAYOUT).includes('appearance.showJoinPart'));
    assert.ok(ids(FULL_LAYOUT).includes('appearance.userList'));
    const headless = ids(HEADLESS_LAYOUT);
    assert.ok(!headless.includes('appearance.showJoinPart'));
    assert.ok(!headless.includes('appearance.userList'));
});

test('the template gates header, channel list, user list and logout on the layout', () => {
    const html = renderTemplate('chat', t);
    for (const condition of ['layout.header', 'layout.channelList', 'layout.userList', 'layout.logout']) {
        assert.ok(html.includes(condition), condition);
    }
});
