/**
 * Settings Mixin
 * The settings window: renders the registry (settings/registry.js), reads and writes
 * values through the definitions and talks to the desktop shell for app-wide and
 * per-connection desktop settings.
 *
 * Shell bridge (notifyHost to the shell, applyShellSettings back from it):
 *  -> settings-get
 *  -> settings-set { scope: 'app'|'connection', key, value }
 *  -> settings-action { action }   e.g. change-log-path, open-log-viewer, copy-error-report
 *  <- applyShellSettings({ app: {...}, connection: {...} })
 */
import { SCOPE, settingsRegistry } from '../settings/registry.js';
import '../settings/definitions.js';
import { normalizeNotificationSound, playNotificationSound } from '../notification-sound.js';

export const WEB_THEME_KEY = 'chat.theme';
export const WEB_THEMES = ['auto', 'dark', 'light'];
const NOTIFICATION_SOUND_KEY = 'chat.notificationSound';

function readStoredValue(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStoredValue(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: the choice only lasts for this page view
    }
}

/**
 * @param {Object} [options]
 * @param {'auto'|'dark'|'light'} [options.defaultTheme] The edition's theme until the user picks one.
 */
export function settingsMixin({ defaultTheme = 'auto' } = {}) {
    const storedTheme = readStoredValue(WEB_THEME_KEY);
    return {
        settingsWindow: { show: false, section: null, query: '' },
        shellSettings: { app: {}, connection: {} },
        webTheme: WEB_THEMES.includes(storedTheme) ? storedTheme : defaultTheme,
        _webThemeChosen: WEB_THEMES.includes(storedTheme),
        notificationSound: normalizeNotificationSound(readStoredValue(NOTIFICATION_SOUND_KEY)),
        listInputs: {},

        /** Replaced by an account sync module (chatState). */
        syncsWithAccount() {
            return false;
        },

        settingsEnv() {
            return {
                shell: this.shell,
                hasFeature: name => this.hasFeature(name),
                hasAccount: Boolean(this.canUseProfiles?.()),
                connectionsApi: Boolean(this.shellSettings?.app?.connectionsApi),
            };
        },

        settingsSections() {
            return settingsRegistry.sectionsFor(this.settingsEnv());
        },

        activeSettingsSection() {
            return this.settingsSections().find(section => section.id === this.settingsWindow.section) || null;
        },

        /** Settings of the active section, or the search results across all sections. */
        visibleSettings() {
            const env = this.settingsEnv();
            return this.settingsWindow.query.trim()
                ? settingsRegistry.search(this.settingsWindow.query, env, key => this.t(key))
                : settingsRegistry.settingsFor(this.settingsWindow.section, env);
        },

        /** Whether a group heading belongs before the setting at `index`. */
        settingStartsGroup(settings, index) {
            const group = settings[index]?.group;
            return Boolean(group) && settings[index - 1]?.group !== group;
        },

        settingSectionLabel(setting) {
            const section = this.settingsSections().find(entry => entry.id === setting.section);
            return section ? this.t(section.label) : '';
        },

        // Window

        openSettings(sectionId = null) {
            const sections = this.settingsSections();
            const target = sections.find(section => section.id === sectionId)
                || sections.find(section => section.id === 'notifications')
                || sections[0];
            this.showingUserOptions = false;
            this.settingsWindow = { show: true, section: target?.id || null, query: '' };
            this.requestShellSettings();
            this.callModuleHook?.('settingsSectionOpened', target?.id);
        },

        selectSettingsSection(sectionId) {
            this.callModuleHook?.('settingsSectionClosed', this.settingsWindow.section);
            this.settingsWindow.section = sectionId;
            this.settingsWindow.query = '';
            this.callModuleHook?.('settingsSectionOpened', sectionId);
        },

        closeSettings() {
            this.callModuleHook?.('settingsSectionClosed', this.settingsWindow.section);
            this.settingsWindow.show = false;
            this.focusMessageInput?.();
        },

        // Values

        settingValue(setting) {
            return setting.get ? setting.get(this) : undefined;
        },

        updateSetting(setting, value) {
            setting.set?.(this, value);
        },

        runSetting(setting) {
            setting.run?.(this);
        },

        /** Button text of an action, may depend on the current state (e.g. connect/disconnect). */
        settingActionLabel(setting) {
            const key = setting.actionLabelFor ? setting.actionLabelFor(this) : setting.actionLabel;
            return key ? this.t(key) : '';
        },

        /** A status is a translation key, or { key, replacements } for texts with numbers. */
        settingStatus(setting) {
            const status = setting.status?.(this);
            if (!status) return '';
            return typeof status === 'object' ? this.t(status.key, status.replacements || {}) : this.t(status);
        },

        listInput(setting) {
            return this.listInputs[setting.id] || '';
        },

        setListInput(setting, value) {
            this.listInputs = { ...this.listInputs, [setting.id]: value };
        },

        addListEntry(setting) {
            const input = this.listInput(setting).trim();
            if (!input || this.isListFull(setting)) return;
            setting.add?.(this, input);
            this.setListInput(setting, '');
        },

        removeListEntry(setting, entry) {
            setting.remove?.(this, entry);
        },

        isListFull(setting) {
            return Boolean(setting.limit) && (this.settingValue(setting) || []).length >= setting.limit;
        },

        /**
         * Where a value applies, shown next to every setting: all tabs, this connection
         * or the account on the server.
         */
        settingScope(setting) {
            const isDesktop = this.shell === 'desktop';
            if (setting.scope === SCOPE.App) return { icon: 'bi-window-stack', label: this.t('settings_scope_app') };
            if (setting.scope === SCOPE.Device) {
                return isDesktop
                    ? { icon: 'bi-window-stack', label: this.t('settings_scope_app') }
                    : { icon: 'bi-laptop', label: this.t('settings_scope_browser') };
            }
            if (setting.scope === SCOPE.Account) return { icon: 'bi-person-check', label: this.t('settings_scope_account') };
            if (setting.accountSync && this.syncsWithAccount()) return { icon: 'bi-cloud-check', label: this.t('settings_scope_synced') };
            return { icon: 'bi-plug', label: this.t('settings_scope_connection') };
        },

        // Desktop shell bridge

        requestShellSettings() {
            if (this.shell) this.notifyHost('settings-get');
        },

        /** Optimistic: the value changes at once, the shell confirms with applyShellSettings(). */
        setShellSetting(scope, key, value) {
            this.shellSettings = {
                ...this.shellSettings,
                [scope]: { ...(this.shellSettings[scope] || {}), [key]: value },
            };
            this.notifyHost('settings-set', { scope, key, value });
        },

        shellAction(action) {
            this.notifyHost('settings-action', { action });
        },

        applyShellSettings(state) {
            this.shellSettings = {
                app: { ...(state?.app || {}) },
                connection: { ...(state?.connection || {}) },
            };
        },

        // Browser settings

        /** Applies the user's choice; without one the edition's theme from mountChat() stays. */
        applyWebTheme() {
            if (this.shell || !this._webThemeChosen) return;
            this.applyTheme(this.webTheme);
        },

        setWebTheme(theme) {
            this.webTheme = WEB_THEMES.includes(theme) ? theme : 'auto';
            this._webThemeChosen = true;
            writeStoredValue(WEB_THEME_KEY, this.webTheme);
            this.applyWebTheme();
        },

        /** Per device: the sound belongs to the speakers of this device, not to the account. */
        setNotificationSound(sound) {
            this.notificationSound = normalizeNotificationSound(sound);
            writeStoredValue(NOTIFICATION_SOUND_KEY, this.notificationSound);
            // Preview, so the choice can be heard right away
            playNotificationSound(this.notificationSound);
        },

        browserNotificationStatus() {
            const permission = globalThis.Notification?.permission;
            if (permission === 'granted') return 'settings_browser_notifications_granted';
            if (permission === 'denied') return 'settings_browser_notifications_denied';
            return 'settings_browser_notifications_default';
        },

        async requestBrowserNotifications() {
            if (globalThis.Notification?.permission !== 'default') return;
            const permission = await Notification.requestPermission();
            // Allowed after the connect: register for push now instead of on the next connect
            if (permission === 'granted') this.registerWebPush?.();
            // permission is not reactive: nudge Alpine to read the status again
            this.settingsWindow = { ...this.settingsWindow };
        },

        /** A device preference changed in another tab (storage event): follow it live. */
        applyDevicePreferenceChange(key, newValue) {
            if (key === 'chat.hideJoinPart') this.hideJoinPart = newValue === '1';
            else if (key === 'chat.userListOpen') this.userListOpen = newValue !== '0';
            else if (key === WEB_THEME_KEY && WEB_THEMES.includes(newValue)) {
                this.webTheme = newValue;
                this._webThemeChosen = true;
                this.applyWebTheme();
            }
        },
    };
}
