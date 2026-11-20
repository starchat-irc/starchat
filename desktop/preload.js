'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Allowed channels for Main → Renderer events
const ALLOWED_RECEIVE_CHANNELS = [
    'set-iframe-src',
    'logout',
    'update-ready',
    'update-status',
    'confirm-close',
    'notification-data',
    'theme-changed',
    'native-socket-event',
    'profiles-changed',
    'irc-link',
];

// Allowed channels for Renderer → Main (fire-and-forget)
const ALLOWED_SEND_CHANNELS = [
    'open-external',
    'logout',
    'mention-update',
    'incoming-message',
    'unread-state-update',
    'unread-update',
    'iframe-loaded',
    'log-chat',
    'retry-connection',
    'save-credentials',
    'encrypt-sasl-password',
    'encrypt-home-sasl-password',
    'load-profile',
    'delete-profile',
    'minimize-window',
    'maximize-window',
    'close-window',
    'notification-clicked',
    'active-profile-changed',
];

contextBridge.exposeInMainWorld('electronAPI', {

    getVersion: () => ipcRenderer.invoke('get-version'),
    getLocale: () => ipcRenderer.invoke('get-locale'),
    getTranslations: (locale) => ipcRenderer.invoke('get-translations', locale),
    getEditionInfo: () => ipcRenderer.invoke('get-edition-info'),
    getStartupNotices: () => ipcRenderer.invoke('get-startup-notices'),
    forceClose: () => ipcRenderer.invoke('force-close'),
    getPendingUpdate: () => ipcRenderer.invoke('get-pending-update'),
    installUpdate: () => ipcRenderer.send('install-update'),

    getProfiles: () =>
        ipcRenderer.invoke('get-profiles'),

    saveProfiles: (profiles) =>
        ipcRenderer.invoke('save-profiles', profiles),

    loadProfile: (hash, token = null) =>
        ipcRenderer.send('load-profile', { hash, token }),

    deleteProfile: (hash) =>
        ipcRenderer.send('delete-profile', hash),

    getToken: (hash) =>
        ipcRenderer.invoke('get-token', hash),

    saveCredentials: (token, remember, profileHash) =>
        ipcRenderer.send('save-credentials', { token, remember, profileHash }),

    encryptSaslPassword: (profileHash, password) =>
        ipcRenderer.send('encrypt-sasl-password', { profileHash, password }),

    encryptHomeSaslPassword: (profileHash, password) =>
        ipcRenderer.send('encrypt-home-sasl-password', { profileHash, password }),

    fetchApiToken: (profileHash, username, password) =>
        ipcRenderer.invoke('fetch-api-token', { profileHash, username, password }),

    logout: (profileHash) =>
        ipcRenderer.send('logout', profileHash),

    minimize: () => ipcRenderer.send('minimize-window'),
    maximize: () => ipcRenderer.send('maximize-window'),
    close:    () => ipcRenderer.send('close-window'),

    openLogViewer: (profileHash) =>
        ipcRenderer.send('open-log-viewer', profileHash),

    nativeSocketConnect: (payload) => ipcRenderer.send('native-socket-connect', payload),
    nativeSocketSend: (payload) => ipcRenderer.send('native-socket-send', payload),
    nativeSocketClose: (payload) => ipcRenderer.send('native-socket-close', payload),
    getCuratedServers: () => ipcRenderer.invoke('get-curated-servers'),
    // Connections page of the chat settings: public profile views only (see connections.js)
    connectionsList: () => ipcRenderer.invoke('connections-list'),
    connectionsSave: (update) => ipcRenderer.invoke('connections-save', update),
    connectionsDelete: (hash) => ipcRenderer.invoke('connections-delete', hash),
    connectionsTest: (payload) => ipcRenderer.invoke('connections-test', payload),
    syncCuratedServers: () => ipcRenderer.invoke('sync-curated-servers'),

    getTheme: () => ipcRenderer.invoke('get-theme'),
    saveTheme: (theme) => ipcRenderer.invoke('save-theme', theme),

    getNotificationSettings: () =>
        ipcRenderer.invoke('get-notification-settings'),

    saveNotificationSettings: (settings) =>
        ipcRenderer.invoke('save-notification-settings', settings),

    sendMentionUpdate: (hasMentions, mentionCount, profileHash) =>
        ipcRenderer.send('mention-update', { hasMentions, mentionCount, profileHash }),

    sendUnreadStateUpdate: (profileHash, totalUnread) =>
        ipcRenderer.send('unread-state-update', { profileHash, totalUnread }),

    sendActiveProfile: (profileHash) =>
        ipcRenderer.send('active-profile-changed', { profileHash }),

    sendUnreadUpdate: (hasUnread, profileHash) =>
        ipcRenderer.send('unread-update', { hasUnread, profileHash }),

    sendIncomingMessage: (data) =>
        ipcRenderer.send('incoming-message', data),

    iframeLoaded: (profileHash, success, src) =>
        ipcRenderer.send('iframe-loaded', { profileHash, success, src }),

    /** The chat's script is running: confirms a chat update in use (chat-bundles.js). */
    chatReady: (profileHash) =>
        ipcRenderer.send('chat-ready', { profileHash }),

    openExternal: (url) =>
        ipcRenderer.send('open-external', url),

    retryConnection: () =>
        ipcRenderer.send('retry-connection'),

    notificationClicked: () =>
        ipcRenderer.send('notification-clicked'),

    logChat: (channel, message, profileHash, loggingEnabled) =>
        ipcRenderer.send('log-chat', { channel, message, profileHash, loggingEnabled }),

    getLogPath: (profileHash) =>
        ipcRenderer.invoke('get-log-path', profileHash),

    changeLogPath: (profileHash) =>
        ipcRenderer.invoke('change-log-path', profileHash),

    getLogFiles: (profileHash) =>
        ipcRenderer.invoke('get-log-files', profileHash),

    getLogContent: (profileHash, filename) =>
        ipcRenderer.invoke('get-log-content', profileHash, filename),

    revealLogFile: (profileHash, filename) =>
        ipcRenderer.invoke('reveal-log-file', { profileHash, filename }),

    on: (channel, callback) => {
        if (!ALLOWED_RECEIVE_CHANNELS.includes(channel)) {
            console.warn(`[preload] Blocked attempt to listen on unknown channel: ${channel}`);
            return () => {};
        }
        const wrapped = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, wrapped);
        return () => ipcRenderer.removeListener(channel, wrapped);
    },

    once: (channel, callback) => {
        if (!ALLOWED_RECEIVE_CHANNELS.includes(channel)) {
            console.warn(`[preload] Blocked attempt to listen on unknown channel: ${channel}`);
            return;
        }
        ipcRenderer.once(channel, (event, ...args) => callback(...args));
    },

    getPlayerSettings:  ()  => ipcRenderer.invoke('player-get-settings'),
    savePlayerSettings: (s) => ipcRenderer.invoke('player-save-settings', s),
    playerOpenFiles:    ()  => ipcRenderer.invoke('player-open-files'),
    playerScanFolder:   ()  => ipcRenderer.invoke('player-scan-folder'),
    playerFetchStreamMetadata: (url) => ipcRenderer.invoke('player-fetch-stream-metadata', url),
    getSystemMediaTrack: (profileHash) => ipcRenderer.invoke('player-get-system-media', profileHash),

    reportRendererError: (payload) => ipcRenderer.send('renderer-error', payload),
    getErrorReportCount: () => ipcRenderer.invoke('get-error-report-count'),
    copyErrorReport:     () => ipcRenderer.invoke('copy-error-report'),
    clearErrorReport:    () => ipcRenderer.invoke('clear-error-report'),

    getAppUrl:        ()             => ipcRenderer.invoke('get-app-url'),
    spotifyStatus:    (profileHash) => ipcRenderer.invoke('spotify-status',    profileHash),
    spotifyAuthUrl:   (profileHash) => ipcRenderer.invoke('spotify-auth-url',  profileHash),
    spotifyDisconnect:(profileHash) => ipcRenderer.invoke('spotify-disconnect',  profileHash),
});

/**
 * Errors of the shell windows (index, manager, log viewer …) go to the local error log.
 * The chat iframes report theirs via postMessage: the shell forwards them.
 * Values from the page's world may be unreadable here (context isolation): read defensively.
 */
function safeRead(read) {
    try {
        return read();
    } catch {
        return undefined;
    }
}

function reportShellError(payload) {
    try {
        ipcRenderer.send('renderer-error', { source: 'shell', ...payload });
    } catch {
        // never let error reporting raise errors of its own
    }
}

window.addEventListener('error', (event) => {
    reportShellError({
        kind: 'error',
        message: event.message || safeRead(() => String(event.error)) || 'Unknown error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: safeRead(() => event.error?.stack),
    });
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = safeRead(() => event.reason);
    reportShellError({
        kind: 'unhandledrejection',
        message: safeRead(() => reason?.message) || safeRead(() => String(reason)) || 'Unhandled rejection',
        stack: safeRead(() => reason?.stack),
    });
});
