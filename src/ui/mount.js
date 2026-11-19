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

/**
 * @param {string|Element} target Selector or element the chat replaces the content of.
 * @param {Object} [options]
 * @param {Object} [options.Alpine] An Alpine instance the page already uses (e.g. from Livewire).
 * @param {string|Object} [options.primaryServer] Domain or server list entry, preselected.
 * @param {'default'|string|false} [options.serverList] 'default' (public list), own URL, or false.
 * @param {string} [options.locale] e.g. "de-DE"; the browser language when left out.
 * @param {Object<string, string>} [options.overrides] Texts that replace bundled ones.
 * @param {string} [options.appName]
 * @param {string} [options.nickname] Connect right away with this nick instead of showing the login form.
 * @param {string} [options.defaultChannel]
 * @param {(type: string, data: Object) => void} [options.onHostMessage]
 * @return {Promise<{ connection: Object, servers: Object[] }>}
 */
export async function mountChat(target, options = {}) {
    const {
        Alpine = DefaultAlpine,
        primaryServer = null,
        serverList = 'default',
        locale = globalThis.navigator?.language,
        overrides = {},
        appName = 'StarChat',
        onHostMessage = () => {},
        ...componentOptions
    } = options;

    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) {
        throw new Error(`mountChat: ${target} not found`);
    }

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
        connection,
        stores,
        t,
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
