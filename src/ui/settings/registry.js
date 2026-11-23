/**
 * Settings registry
 *
 * Describes every setting of the chat as data: section, type, scope, visibility and
 * how to read/write it. The settings window renders whatever is registered here, so a
 * new feature (or later a script) only has to register its settings.
 *
 * Scopes (where a value lives and who follows a change):
 *  - app:        desktop app, shared by all tabs (stored by the shell)
 *  - device:     this device/browser, all tabs of the same origin follow live
 *  - connection: this connection; synced with the account when the server offers it (chatState)
 *  - account:    the account on the server itself (profile), only with the matching feature
 */

export const SCOPE = Object.freeze({
    App: 'app',
    Device: 'device',
    Connection: 'connection',
    Account: 'account',
});

export const SETTING_TYPES = Object.freeze(['toggle', 'select', 'list', 'text', 'path', 'action', 'custom']);

/**
 * @typedef {Object} SettingsEnv
 * @property {string|null} shell     'desktop', 'mobile' or null (web)
 * @property {import('../layout.js').ChatLayout} [layout] parts of the chat the page shows
 * @property {(name: string) => boolean} hasFeature  feature of the connected server
 * @property {boolean} hasAccount   logged into an account on a server with profiles
 * @property {boolean} hasToken     the connection has an API token (not a guest)
 */

/**
 * @typedef {Object} SectionDefinition
 * @property {string} id
 * @property {string} label       translation key
 * @property {string} icon        bootstrap icon class
 * @property {number} [order]
 * @property {(env: SettingsEnv) => boolean} [when]
 */

/**
 * @typedef {Object} SettingDefinition
 * @property {string} id
 * @property {string} section
 * @property {string} type                 one of SETTING_TYPES
 * @property {string} scope                one of SCOPE
 * @property {string} label                translation key
 * @property {string} [hint]               translation key
 * @property {string} [group]              translation key of a heading inside the section
 * @property {string[]} [keywords]         extra search terms
 * @property {number} [order]
 * @property {(env: SettingsEnv) => boolean} [when]
 * @property {(chat: object) => *} [get]
 * @property {(chat: object, value: *) => void} [set]
 * @property {(chat: object) => void} [run]           action/path button
 * @property {string} [actionLabel]                   translation key of the button
 * @property {{ value: string, label: string }[]} [options]  select options (label = translation key)
 * @property {string} [placeholder]                   list/text input placeholder (translation key)
 * @property {number} [maxLength]                     text: maximum characters
 * @property {number} [limit]                         list: maximum entries
 * @property {string} [view]                          custom: name of the view to render
 */

function isVisible(definition, env) {
    return typeof definition.when !== 'function' || Boolean(definition.when(env));
}

function byOrder(a, b) {
    return (a.order ?? 100) - (b.order ?? 100);
}

export function createSettingsRegistry() {
    const sections = new Map();
    const settings = new Map();

    return {
        /** @param {SectionDefinition} definition */
        registerSection(definition) {
            if (!definition?.id || !definition.label) throw new Error('A settings section needs an id and a label');
            sections.set(definition.id, { icon: 'bi-gear', ...definition });
            return this;
        },

        /** @param {SettingDefinition} definition */
        registerSetting(definition) {
            if (!definition?.id || !definition.section || !definition.label) {
                throw new Error('A setting needs an id, a section and a label');
            }
            if (!SETTING_TYPES.includes(definition.type)) {
                throw new Error(`Unknown setting type "${definition.type}" for ${definition.id}`);
            }
            if (!Object.values(SCOPE).includes(definition.scope)) {
                throw new Error(`Unknown setting scope "${definition.scope}" for ${definition.id}`);
            }
            settings.set(definition.id, definition);
            return this;
        },

        get(id) {
            return settings.get(id) || null;
        },

        /** Sections that have at least one visible setting in this environment. */
        sectionsFor(env) {
            return [...sections.values()]
                .filter(section => isVisible(section, env))
                .filter(section => this.settingsFor(section.id, env).length > 0)
                .sort(byOrder);
        },

        settingsFor(sectionId, env) {
            return [...settings.values()]
                .filter(setting => setting.section === sectionId && isVisible(setting, env))
                .filter(setting => isVisible(sections.get(setting.section) || {}, env))
                .sort(byOrder);
        },

        /**
         * Settings matching a search text (label, hint, group, section, keywords).
         *
         * @param {string} query
         * @param {SettingsEnv} env
         * @param {(key: string) => string} translate
         */
        search(query, env, translate = key => key) {
            const needle = String(query ?? '').trim().toLowerCase();
            if (!needle) return [];
            return this.sectionsFor(env).flatMap(section => this.settingsFor(section.id, env)
                .filter(setting => [
                    translate(setting.label),
                    setting.hint ? translate(setting.hint) : '',
                    setting.group ? translate(setting.group) : '',
                    translate(section.label),
                    ...(setting.keywords || []),
                ].join(' ').toLowerCase().includes(needle)));
        },
    };
}

/** The registry of the running chat. Feature modules and editions register their settings here. */
export const settingsRegistry = createSettingsRegistry();

