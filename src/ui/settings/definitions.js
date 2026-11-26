/**
 * Built-in settings of the chat. Every entry says where its value lives (scope) and
 * reads/writes it through the chat component; the settings window only renders.
 * Feature modules (account, voice, push) register their own entries.
 */
import { SCOPE, settingsRegistry } from './registry.js';
import { HIGHLIGHT_WORDS_LIMIT } from '../../core/formatting.js';
import { AUTOJOIN_CHANNELS_LIMIT, IGNORE_LIST_LIMIT, QUIT_MESSAGE_MAX_LENGTH, normalizeNickList } from '../mixins/preferences.js';
import { NOTIFICATION_SOUNDS } from '../notification-sound.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../mixins/display-names.js';

/** Settings the desktop shell keeps. The mobile shell has none of them (theme follows the system). */
const desktop = env => env.shell === 'desktop';
const browser = env => !env.shell;
const mobileApp = env => env.shell === 'mobile';
/** A part the embedding page has not switched off (mountChat option "layout"). */
const shown = part => env => env.layout?.[part] !== false;

/** A value kept by the desktop shell (app-wide or per connection). */
function shellToggle(scope, key) {
    return {
        get: chat => Boolean(chat.shellSettings?.[scope]?.[key]),
        set: (chat, value) => chat.setShellSetting(scope, key, Boolean(value)),
    };
}

export function registerBuiltinSettings(registry = settingsRegistry) {
    registry
        .registerSection({ id: 'notifications', label: 'settings_section_notifications', icon: 'bi-bell', order: 20 })
        .registerSection({ id: 'appearance', label: 'settings_section_appearance', icon: 'bi-palette', order: 30 })
        .registerSection({ id: 'chat', label: 'settings_section_chat', icon: 'bi-chat-left-text', order: 40 })
        .registerSection({ id: 'media', label: 'settings_section_media', icon: 'bi-music-note-beamed', order: 50, when: desktop })
        .registerSection({ id: 'logging', label: 'settings_section_logging', icon: 'bi-journal-text', order: 60, when: desktop })
        .registerSection({ id: 'diagnostics', label: 'settings_section_diagnostics', icon: 'bi-bug', order: 80, when: desktop });

    // Notifications
    registry.registerSetting({
        id: 'notifications.highlightWords',
        section: 'notifications',
        type: 'list',
        scope: SCOPE.Connection,
        accountSync: true,
        order: 10,
        label: 'highlight_words',
        hint: 'highlight_words_hint',
        placeholder: 'highlight_add_placeholder',
        limit: HIGHLIGHT_WORDS_LIMIT,
        keywords: ['highlight', 'mention', 'erwähnung', 'keyword'],
        get: chat => chat.highlightWords,
        add: (chat, input) => chat.addHighlightWords(input),
        remove: (chat, word) => chat.removeHighlightWord(word),
    });
    registry.registerSetting({
        id: 'notifications.sound',
        section: 'notifications',
        type: 'select',
        scope: SCOPE.Device,
        order: 15,
        label: 'settings_notification_sound',
        hint: 'settings_notification_sound_hint',
        // A getter: an edition may add its own sound after this module was loaded
        get options() {
            return NOTIFICATION_SOUNDS.map(sound => ({ value: sound, label: `settings_notification_sound_${sound}` }));
        },
        keywords: ['ton', 'sound', 'klang', 'highlight', 'erwähnung', 'mention', 'leise'],
        get: chat => chat.notificationSound,
        set: (chat, value) => chat.setNotificationSound(value),
    });
    registry.registerSetting({
        id: 'notifications.dmPopup',
        section: 'notifications',
        type: 'toggle',
        scope: SCOPE.App,
        group: 'settings_group_popups',
        order: 20,
        when: desktop,
        label: 'settings_notify_dm',
        ...shellToggle('app', 'notifyDmPopup'),
    });
    registry.registerSetting({
        id: 'notifications.mentionPopup',
        section: 'notifications',
        type: 'toggle',
        scope: SCOPE.App,
        group: 'settings_group_popups',
        order: 21,
        when: desktop,
        label: 'settings_notify_mention',
        ...shellToggle('app', 'notifyMentionPopup'),
    });
    registry.registerSetting({
        id: 'notifications.minimized',
        section: 'notifications',
        type: 'toggle',
        scope: SCOPE.App,
        group: 'settings_group_popups',
        order: 22,
        when: desktop,
        label: 'settings_notify_minimized',
        hint: 'settings_notify_minimized_hint',
        ...shellToggle('app', 'notifyAnyWhenMinimized'),
    });
    registry.registerSetting({
        id: 'notifications.browser',
        section: 'notifications',
        type: 'action',
        scope: SCOPE.Device,
        order: 20,
        when: browser,
        label: 'settings_browser_notifications',
        hint: 'settings_browser_notifications_hint',
        actionLabel: 'settings_browser_notifications_enable',
        status: chat => chat.browserNotificationStatus(),
        run: chat => chat.requestBrowserNotifications(),
    });
    registry.registerSetting({
        id: 'notifications.mobileSettings',
        section: 'notifications',
        type: 'action',
        scope: SCOPE.Device,
        order: 31,
        when: mobileApp,
        label: 'settings_android_notifications',
        hint: 'settings_android_notifications_hint',
        actionLabel: 'settings_android_notifications_open',
        keywords: ['ton', 'sound', 'vibration', 'kanal', 'channel', 'leise', 'laut'],
        run: chat => chat.shellAction('open-notification-settings'),
    });

    // Appearance
    registry.registerSetting({
        id: 'appearance.theme',
        section: 'appearance',
        type: 'select',
        scope: SCOPE.App,
        order: 10,
        when: desktop,
        label: 'settings_theme',
        options: [
            { value: 'dark', label: 'settings_theme_dark' },
            { value: 'light', label: 'settings_theme_light' },
        ],
        keywords: ['dark', 'light', 'hell', 'dunkel', 'design'],
        get: chat => chat.shellSettings?.app?.theme || 'dark',
        set: (chat, value) => chat.setShellSetting('app', 'theme', value),
    });
    registry.registerSetting({
        id: 'appearance.themeBrowser',
        section: 'appearance',
        type: 'select',
        scope: SCOPE.Device,
        order: 10,
        when: browser,
        label: 'settings_theme',
        options: [
            { value: 'auto', label: 'settings_theme_auto' },
            { value: 'dark', label: 'settings_theme_dark' },
            { value: 'light', label: 'settings_theme_light' },
        ],
        keywords: ['dark', 'light', 'hell', 'dunkel', 'design', 'system'],
        get: chat => chat.webTheme,
        set: (chat, value) => chat.setWebTheme(value),
    });
    registry.registerSetting({
        id: 'appearance.showJoinPart',
        section: 'appearance',
        type: 'toggle',
        scope: SCOPE.Device,
        order: 20,
        when: shown('joinPart'),
        label: 'settings_show_join_part',
        hint: 'settings_show_join_part_hint',
        keywords: ['join', 'part', 'quit'],
        get: chat => !chat.hideJoinPart,
        set: (chat, value) => { if (chat.hideJoinPart === Boolean(value)) chat.toggleJoinPart(); },
    });
    registry.registerSetting({
        id: 'appearance.userList',
        section: 'appearance',
        type: 'toggle',
        scope: SCOPE.Device,
        order: 30,
        when: shown('userList'),
        label: 'settings_show_user_list',
        keywords: ['nicklist', 'benutzer', 'users'],
        get: chat => chat.userListOpen,
        set: (chat, value) => chat.setUserListOpen(value),
    });

    // Chat
    registry.registerSetting({
        id: 'chat.ignoredUsers',
        section: 'chat',
        type: 'list',
        scope: SCOPE.Connection,
        accountSync: true,
        order: 10,
        label: 'settings_ignore_list',
        hint: 'settings_ignore_list_hint',
        placeholder: 'settings_ignore_placeholder',
        limit: IGNORE_LIST_LIMIT,
        keywords: ['ignore', 'block', 'blockieren'],
        get: chat => chat.ignoredUsers,
        add: (chat, input) => chat.setIgnoredUsers([...chat.ignoredUsers, ...normalizeNickList(input)]),
        remove: (chat, nick) => chat.unignoreUser(nick),
    });
    registry.registerSetting({
        id: 'chat.autojoinChannels',
        section: 'chat',
        type: 'list',
        scope: SCOPE.Connection,
        accountSync: true,
        order: 15,
        label: 'settings_autojoin',
        hint: 'settings_autojoin_hint',
        placeholder: 'settings_autojoin_placeholder',
        limit: AUTOJOIN_CHANNELS_LIMIT,
        keywords: ['autojoin', 'channel', 'kanal', 'start', 'betreten', 'join'],
        get: chat => chat.autojoinChannels,
        add: (chat, input) => chat.addAutojoinChannels(input),
        remove: (chat, channel) => chat.removeAutojoinChannel(channel),
    });
    registry.registerSetting({
        id: 'chat.quitMessage',
        section: 'chat',
        type: 'text',
        scope: SCOPE.Connection,
        accountSync: true,
        order: 20,
        label: 'settings_quit_message',
        hint: 'settings_quit_message_hint',
        placeholder: 'settings_quit_message_placeholder',
        maxLength: QUIT_MESSAGE_MAX_LENGTH,
        keywords: ['quit', 'abschied', 'verlassen', 'goodbye'],
        get: chat => chat.quitMessage,
        set: (chat, value) => chat.setQuitMessage(value),
    });
    registry.registerSetting({
        id: 'chat.displayName',
        section: 'chat',
        type: 'text',
        scope: SCOPE.Connection,
        order: 5,
        label: 'display_name',
        hint: 'display_name_hint',
        placeholder: 'display_name_placeholder',
        maxLength: DISPLAY_NAME_MAX_LENGTH,
        keywords: ['display name', 'anzeigename', 'name', 'nick', 'nickname', 'spitzname'],
        get: chat => chat.ownDisplayName,
        set: (chat, value) => chat.changeOwnDisplayName(value),
    });

    // Media (desktop)
    registry.registerSetting({
        id: 'media.richPresence',
        section: 'media',
        type: 'toggle',
        scope: SCOPE.App,
        order: 10,
        label: 'settings_rich_presence',
        hint: 'settings_rich_presence_hint',
        keywords: ['now playing', 'musik', 'player'],
        ...shellToggle('app', 'playerRichPresence'),
    });
    registry.registerSetting({
        id: 'media.systemMedia',
        section: 'media',
        type: 'toggle',
        scope: SCOPE.App,
        order: 20,
        label: 'settings_system_media',
        hint: 'settings_system_media_hint',
        keywords: ['spotify', 'now playing', 'musik'],
        ...shellToggle('app', 'systemMediaRichPresence'),
    });

    // Logging (desktop)
    registry.registerSetting({
        id: 'logging.enabled',
        section: 'logging',
        type: 'toggle',
        scope: SCOPE.Connection,
        order: 10,
        label: 'settings_logging_enable',
        hint: 'settings_logging_enable_hint',
        keywords: ['log', 'protokoll'],
        ...shellToggle('connection', 'loggingEnabled'),
    });
    registry.registerSetting({
        id: 'logging.path',
        section: 'logging',
        type: 'path',
        scope: SCOPE.Connection,
        order: 20,
        label: 'settings_log_directory',
        actionLabel: 'settings_log_change',
        keywords: ['ordner', 'folder', 'verzeichnis'],
        get: chat => chat.shellSettings?.connection?.logPath || '',
        run: chat => chat.shellAction('change-log-path'),
    });
    registry.registerSetting({
        id: 'logging.viewer',
        section: 'logging',
        type: 'action',
        scope: SCOPE.Connection,
        order: 30,
        label: 'settings_log_viewer',
        actionLabel: 'settings_log_viewer_open',
        run: chat => chat.shellAction('open-log-viewer'),
    });

    // Diagnostics (desktop)
    registry.registerSetting({
        id: 'diagnostics.errorReport',
        section: 'diagnostics',
        type: 'action',
        scope: SCOPE.App,
        order: 10,
        label: 'settings_error_report',
        hint: 'settings_error_report_hint',
        keywords: ['fehler', 'error', 'bug', 'absturz', 'crash', 'bericht', 'report'],
        status: chat => (chat.shellSettings?.app?.errorReportCopied
            ? 'settings_error_report_copied'
            : { key: 'settings_error_report_count', replacements: { count: chat.shellSettings?.app?.errorReportCount || 0 } }),
        actionLabel: 'settings_error_report_copy',
        run: chat => chat.shellAction('copy-error-report'),
    });
    registry.registerSetting({
        id: 'diagnostics.clearErrorReport',
        section: 'diagnostics',
        type: 'action',
        scope: SCOPE.App,
        order: 20,
        label: 'settings_error_report_clear_label',
        actionLabel: 'settings_error_report_clear',
        run: chat => chat.shellAction('clear-error-report'),
    });

    return registry;
}

registerBuiltinSettings();
