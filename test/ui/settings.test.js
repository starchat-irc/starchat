/**
 * Settings registry, built-in definitions and the settings mixin.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { messages } from '../../src/i18n/index.js';
import { createSettingsRegistry, settingsRegistry } from '../../src/ui/settings/registry.js';
import { createTestChat, installBrowserStubs } from './chat-harness.js';
import { settingsMixin } from '../../src/ui/mixins/settings.js';

let storage;

beforeEach(() => {
    storage = installBrowserStubs();
});

const webEnv = { shell: null, hasFeature: () => false, hasAccount: false, connectionsApi: false };
const desktopEnv = { ...webEnv, shell: 'desktop' };

/** Every translation key a section or setting refers to. */
function keysOf(env) {
    return settingsRegistry.sectionsFor(env).flatMap(section => [
        section.label,
        ...settingsRegistry.settingsFor(section.id, env).flatMap(setting => [
            setting.label, setting.hint, setting.group, setting.placeholder, setting.actionLabel,
            ...(setting.options || []).map(option => option.label),
        ]),
    ]).filter(Boolean);
}

test('every built-in setting is translated in English and German', () => {
    const keys = new Set([...keysOf(webEnv), ...keysOf(desktopEnv)]);
    const missing = [...keys].filter(key => !messages.en[key] || !messages.de[key]);
    assert.deepEqual(missing, []);
});

test('the web chat shows no desktop sections', () => {
    const web = settingsRegistry.sectionsFor(webEnv).map(section => section.id);
    assert.deepEqual(web, ['notifications', 'appearance', 'chat']);
    const desktop = settingsRegistry.sectionsFor(desktopEnv).map(section => section.id);
    assert.ok(desktop.includes('logging') && desktop.includes('diagnostics'));
});

test('a feature module can add its own section', () => {
    const registry = createSettingsRegistry();
    registry.registerSection({ id: 'voice', label: 'settings_section_voice', when: env => env.hasFeature('voice') });
    registry.registerSetting({ id: 'voice.enabled', section: 'voice', type: 'toggle', scope: 'device', label: 'settings_voice_enabled' });
    assert.deepEqual(registry.sectionsFor(webEnv), []);
    assert.equal(registry.sectionsFor({ ...webEnv, hasFeature: name => name === 'voice' }).length, 1);
});

test('search finds settings across sections', () => {
    const results = settingsRegistry.search('ignore', webEnv, key => messages.en[key] || key).map(setting => setting.id);
    assert.ok(results.includes('chat.ignoredUsers'));
});

test('list settings add and remove through the chat', () => {
    const { chat } = createTestChat({ state: settingsMixin() });
    chat.openSettings('chat');
    const ignore = chat.visibleSettings().find(setting => setting.id === 'chat.ignoredUsers');
    chat.setListInput(ignore, 'troll, spammer');
    chat.addListEntry(ignore);
    assert.deepEqual(chat.settingValue(ignore), ['troll', 'spammer']);
    chat.removeListEntry(ignore, 'troll');
    assert.deepEqual(chat.ignoredUsers, ['spammer']);
});

test('the browser theme starts with the edition default and remembers a choice', () => {
    const applied = [];
    const chat = Object.assign({}, settingsMixin({ defaultTheme: 'light' }), {
        shell: null,
        applyTheme: theme => applied.push(theme),
    });
    assert.equal(chat.webTheme, 'light');
    chat.applyWebTheme();
    assert.deepEqual(applied, []);

    chat.setWebTheme('dark');
    assert.deepEqual(applied, ['dark']);
    assert.equal(storage.get('chat.theme'), 'dark');

    const later = Object.assign({}, settingsMixin({ defaultTheme: 'light' }));
    assert.equal(later.webTheme, 'dark');
});

test('desktop settings go to the shell', () => {
    const sent = [];
    const chat = Object.assign({}, settingsMixin(), {
        shell: 'desktop',
        notifyHost: (type, data = {}) => sent.push({ type, ...data }),
    });
    chat.requestShellSettings();
    chat.setShellSetting('app', 'notifyDmPopup', true);
    chat.shellAction('open-log-viewer');
    assert.deepEqual(sent, [
        { type: 'settings-get' },
        { type: 'settings-set', scope: 'app', key: 'notifyDmPopup', value: true },
        { type: 'settings-action', action: 'open-log-viewer' },
    ]);
    assert.equal(chat.shellSettings.app.notifyDmPopup, true);
});
