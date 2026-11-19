/**
 * mountChat(): renders the chat into an element and starts it with Alpine.
 */
import DefaultAlpine from 'alpinejs';
import { alpineStore } from '../core/store.js';
import { resolveServers } from '../core/servers.js';
import { openConnection } from '../core/connection.js';
import { createTranslator } from '../i18n/index.js';
import { renderTemplate } from './templates.js';
import { createChatComponent } from './component.js';
import { createChannelManagementState } from './mixins/channel-management.js';
import { emojiPicker } from './emoji-picker.js';
import { applyColorScheme } from './color-scheme.js';
import { settingsRegistry } from './settings/registry.js';
import { defaultModules } from '../modules/index.js';

/**
 * @param {string|Element} target Selector or element the chat replaces the content of.
 * @param {Object} [options]
 * @param {Object} [options.Alpine] An Alpine instance the page already uses (e.g. from Livewire).
 * @param {string|Object} [options.primaryServer] Domain or server list entry, preselected.
 * @param {'default'|string|false} [options.serverList] 'default' (public list), own URL, or false.
 * @param {string|string[]} [options.locale] e.g. "de-DE"; the browser languages when left out.
 * @param {'auto'|'dark'|'light'} [options.theme] 'auto' follows the system setting.
 * @param {Object<string, string>} [options.overrides] Texts that replace bundled ones.
 * @param {string} [options.appName]
 * @param {string} [options.nickname] Connect right away with this nick instead of showing the login form.
 * @param {string} [options.defaultChannel]
 * @param {(type: string, data: Object) => void} [options.onHostMessage]
 * @param {import('../modules/index.js').ChatModule[]} [options.modules] Feature modules, all bundled
 *   ones when left out. A module only runs on servers that offer its feature.
 * @param {() => Promise<import('./embed.js').BearerLogin|null>} [options.bearer] Login with a token
 *   instead of the login dialog, e.g. bearerFromParent({ allowedOrigins }) inside an iframe.
 * @param {string} [options.pushWorker] URL of a copy of starchat/push-sw.js on this origin. Turns on
 *   browser push on networks with draft/webpush; see the comment at the top of that file.
 * @return {Promise<{ connection: Object, servers: Object[] }>}
 */
export async function mountChat(target, options = {}) {
    const {
        Alpine = DefaultAlpine,
        primaryServer = null,
        serverList = 'default',
        locale = globalThis.navigator?.languages?.length ? globalThis.navigator.languages : globalThis.navigator?.language,
        theme = 'auto',
        overrides = {},
        appName = 'StarChat',
        onHostMessage = () => {},
        modules = defaultModules,
        ...componentOptions
    } = options;

    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) {
        throw new Error(`mountChat: ${target} not found`);
    }
    applyColorScheme(element, theme);

    modules.forEach(module => module.register?.(settingsRegistry));

    const t = createTranslator({ locale, overrides, appName });
    const { primary, servers } = await resolveServers({ primaryServer, serverList });
    if (!primary) {
        throw new Error('mountChat: no server to connect to');
    }
    const connection = await openConnection(primary);

    for (const [name, initial] of Object.entries({
        messages: {},
        users: {},
        channelTopics: {},
        channelManagement: createChannelManagementState(),
    })) {
        if (!Alpine.store(name)) {
            Alpine.store(name, initial);
        }
    }
    const stores = Object.fromEntries(
        ['messages', 'users', 'channelTopics', 'channelManagement'].map((name) => [name, alpineStore(Alpine, name)]),
    );

    Alpine.data('chatComponent', () => createChatComponent({
        ...componentOptions,
        modules,
        connection,
        stores,
        t,
        defaultTheme: theme,
        servers: serverList === false ? [primary] : servers,
        openServerConnection: (server) => openConnection(server),
        notifyHost: onHostMessage,
        rawOf: (value) => Alpine.raw(value),
    }));

    Alpine.data('emojiPicker', () => emojiPicker(t));

    element.innerHTML = renderTemplate('chat', t);

    // The page's own Alpine runs already and only needs the new tree; our own one is started once.
    if (options.Alpine || globalThis.__starchatAlpineStarted) {
        Alpine.initTree(element);
    } else {
        globalThis.__starchatAlpineStarted = true;
        Alpine.start();
    }

    return { connection, servers };
}
