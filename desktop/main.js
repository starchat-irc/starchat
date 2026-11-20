const { app, BrowserWindow, screen, ipcMain, dialog, safeStorage, session, shell, Notification, nativeImage, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs').promises;
const fsSync = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { v4: uuidv4 } = require('uuid');
const { parseFile } = require('music-metadata');
const { execFile } = require('child_process');
const os = require('os');

const recentNotifications = new Map(); // key -> timestamp
const NOTIF_DEDUP_TTL = 2000; // 2 Sekunden

const { loadEdition, loadBundledServerList, directoryEntries, directoryDomainFor, chooseDataDir, shellTexts, serverListUrl, toDirectoryEntries, createDiscoveryCache } = require('./edition');
const { SCHEMES: IRC_SCHEMES, parseIrcUrl, ircUrlFromArgs, profileForLink } = require('./irc-links');

/** Build time settings of this app (name, ids, servers), see edition.schema.json. */
const edition = loadEdition();
const APP_NAME = edition.appName;
const APP_ID = edition.appId;
const USER_AGENT = `${APP_NAME}/${edition.version}`;
/** API level of the shell (package.json → starchat.nativeApi); chat updates that need a newer one are skipped. */
const NATIVE_API = Number(require('./package.json').starchat?.nativeApi || 1);
const APP_ICON = path.join(__dirname, 'generated', 'icon.png');

const recentLogEntries = new Map(); // key -> timestamp
const LOG_DEDUP_TTL = 1000; // 1 Sekunde

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.isQuitting = false;
// Zentrale Profile-/Token-DB


/** Data directory of the edition (profiles, logs, chat storage), see chooseDataDir(). */
function editionDataDir() {
    const appDataPath = app.getPath('appData');
    return path.join(appDataPath, chooseDataDir(edition, name => fsSync.existsSync(path.join(appDataPath, name))));
}

function useEditionUserDataPath() {
    app.setPath('userData', editionDataDir());
}

/**
 * Development (npm run start) gets its own data directory. Sharing it with an installed
 * copy of the app blocks storage (both open the same LocalStorage database: the dev app
 * hung ~11 s at start while the installed one was running) and dev tests would change
 * the real profiles, tokens and logs. The first dev start copies the stored profiles over
 * once, so nothing has to be set up again.
 */
function useDevelopmentUserDataPath() {
    try {
        const appDataPath = app.getPath('appData');
        const devPath = path.join(appDataPath, `${edition.dataDir}-dev`);
        if (!fsSync.existsSync(devPath)) {
            fsSync.mkdirSync(devPath, { recursive: true });
            const source = [editionDataDir()]
                .find(dir => dir !== devPath && fsSync.existsSync(dir));
            if (source) {
                // electron-store files only (profiles, servers, per-profile stores): no caches
                for (const file of fsSync.readdirSync(source)) {
                    if (file.endsWith('.json')) fsSync.copyFileSync(path.join(source, file), path.join(devPath, file));
                }
                console.info(`[startup] Seeded dev data directory from ${source}`);
            }
        }
        app.setPath('userData', devPath);
        console.info(`[startup] Using dev userData path: ${devPath}`);
    } catch (err) {
        console.warn('[startup] Failed to set up the dev userData path:', err);
    }
}

if (app.isPackaged) {
    useEditionUserDataPath();
} else {
    useDevelopmentUserDataPath();
}

/**
 * One instance per data directory: a second start would block on the same storage
 * (LocalStorage, profile stores) and connect every profile twice. It only brings the
 * running window to the front. The lock is bound to the userData path chosen above, so
 * the dev app (own directory) can still run next to an installed one.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    console.info(`[startup] ${APP_NAME} is already running, focusing the open window.`);
    app.quit();
} else {
    app.on('second-instance', (event, argv = []) => {
        const link = ircUrlFromArgs(argv);
        if (link) handleIrcLink(link);
        const win = (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
            ? mainWindow
            : (splashWindow && !splashWindow.isDestroyed() ? splashWindow : mainWindow);
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
}

const appStore = new Store({ name: 'app-profiles' });
const curatedServerStore = new Store({ name: 'curated-servers' });

function isDuplicateNotification(key) {
    const now = Date.now();
    if (recentNotifications.has(key)) {
        const ts = recentNotifications.get(key);
        if (now - ts < NOTIF_DEDUP_TTL) return true;
    }
    recentNotifications.set(key, now);
    // Cleanup alter Einträge
    for (const [k, ts] of recentNotifications) {
        if (now - ts > NOTIF_DEDUP_TTL) recentNotifications.delete(k);
    }
    return false;
}

function createBadgeOverlay(count) {
    const text = count > 99 ? '99+' : String(count);
    // 16x16 roter Kreis mit weißer Zahl als raw RGBA pixels
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4, 0); // RGBA

    // Zeichne einen roten Kreis
    const cx = 8, cy = 8, r = 7;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
            if (dist <= r) {
                const idx = (y * size + x) * 4;
                canvas[idx] = 231;     // R
                canvas[idx + 1] = 76;  // G
                canvas[idx + 2] = 60;  // B
                canvas[idx + 3] = 255; // A
            }
        }
    }

    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

/**
 * Discovery file of the edition's primary server: API for login, Spotify and the like.
 * Editions without a primary server (the generic StarChat app) have none of that.
 */
const primaryDiscovery = edition.chat.primaryServer
    ? createDiscoveryCache({ domain: edition.chat.primaryServer, userAgent: USER_AGENT })
    : { get: async () => null, apiBaseUrl: async () => null, hasFeature: async () => false };

// ---------------- Security helpers (see security.js) ----------------

const {
    isSafeExternalUrl,
    isFileUrlInside,
    resolveLogFilePath,
    sanitizeIrcLine,
    redactIrcLine,
    isConfiguredSocketTarget,
    isValidConnectionTarget,
    connectionErrorReason,
    isAllowedMediaRequest,
} = require('./security');
const { createUpdateScheduler } = require('./updates');
const { createChatBundleManager } = require('./chat-bundles');
const {
    usableProfiles, mergeShellProfiles, mayUseCredentials, publicProfile, applyConnectionUpdate, canDeleteConnection, createTestLimiter,
} = require('./connections');

/** Credentials of this profile may go to its server (home profiles: bound to this edition's primary server). */
function credentialsAllowed(profile) {
    const allowed = mayUseCredentials(profile, edition.chat.primaryServer || '');
    if (profile && !allowed) log.warn(`Credentials of profile ${profile.hash} withheld: it belongs to another server than ${edition.chat.primaryServer || '(none)'}`);
    return allowed;
}
const { createErrorLog } = require('./error-report');

// ---------------- Chat updates without a new installer (see chat-bundles.js) ----------------

const BUILT_IN_CHAT_DIR = path.join(__dirname, 'generated', 'chat');
// Not "chat-bundles": that folder may hold chat updates of an older app in the same data
// folder (its own chat page), which this app must never load.
const CHAT_BUNDLES_DIR = path.join(app.getPath('userData'), 'chat-updates');
/** A chat from a bundle must report back (chat-ready) within this time, otherwise it is dropped. */
const CHAT_READY_TIMEOUT_MS = 20 * 1000;

const chatBundles = createChatBundleManager({
    baseDir: CHAT_BUNDLES_DIR,
    builtInDir: BUILT_IN_CHAT_DIR,
    nativeApi: NATIVE_API,
    userAgent: USER_AGENT,
    publicKey: (() => {
        if (!edition.chatBundles) return null;
        try {
            return fsSync.readFileSync(path.join(__dirname, 'generated', 'chat-bundle-key.pem'), 'utf8');
        } catch {
            return null; // no key shipped: chat updates stay off
        }
    })(),
    // Only editions with signed chat updates have a manifest (see edition.schema.json)
    manifestUrl: edition.chatBundles?.manifestUrl || null,
    logger: log,
});
/** profileHash -> { version, timer } of chats from a bundle that did not report back yet */
const pendingChatConfirmations = new Map();
/** Bundle versions loaded in this session (kept on disk while the app runs). */
const runningChatVersions = new Set();

/** True for file:// URLs that point inside the bundled app directory or a downloaded chat. */
function isBundledFileUrl(url) {
    return isFileUrlInside(url, __dirname) || isFileUrlInside(url, CHAT_BUNDLES_DIR);
}

function openExternalSafely(url) {
    if (!isSafeExternalUrl(url)) {
        log.warn(`Blocked external URL with disallowed protocol: ${String(url).slice(0, 200)}`);
        return false;
    }
    shell.openExternal(url);
    return true;
}

// Pro-Profil-Store (für Log-Pfade etc.)
const stores = new Map();
function getStore(profileHash) {
    if (!stores.has(profileHash)) {
        stores.set(profileHash, new Store({ name: `profile-${profileHash}` }));
    }
    return stores.get(profileHash);
}

function cleanupOrphanedProfileStores() {
    try {
        const userDataPath = app.getPath('userData');
        const profiles = appStore.get('profiles', []);
        const activeHashes = new Set(profiles.map(p => p.hash));
        const files = fsSync.readdirSync(userDataPath);
        let removed = 0;

        for (const file of files) {
            const match = file.match(/^profile-(.+)\.json$/);
            if (match && !activeHashes.has(match[1])) {
                try {
                    fsSync.unlinkSync(path.join(userDataPath, file));
                    removed++;
                } catch (e) {
                    log.warn(`Could not delete orphaned store ${file}:`, e.message);
                }
            }
        }

        if (removed > 0) {
            log.info(`Cleaned up ${removed} orphaned profile store file(s)`);
        }
    } catch (e) {
        log.warn('Profile store cleanup failed:', e.message);
    }
}

// Log-Verzeichnisse
const logDirs = new Map();
async function getLogDir(profileHash, createIfMissing = false) {
    let logDir;
    if (profileHash && !logDirs.has(profileHash)) {
        const store = getStore(profileHash);
        logDir = store.get('logDir', path.join(app.getPath('userData'), `logs/profile-${profileHash}`));
        logDirs.set(profileHash, logDir);
    } else if (!profileHash) {
        logDir = path.join(app.getPath('userData'), 'logs/web');
        logDirs.set('web', logDir);
    } else {
        logDir = logDirs.get(profileHash);
    }
    if (createIfMissing) {
        await fs.mkdir(logDir, { recursive: true }).catch(err => log.error(`Failed to create log directory ${logDir}:`, err));
    }
    return logDir;
}

log.transports.file.level = 'info';
log.transports.file.fileName = 'main.log';

const chatLogTransport = log.transports.file;
chatLogTransport.level = 'info';
chatLogTransport.format = '[{h}:{i}:{s}] {text}';

autoUpdater.logger = log;
// Editions without "updates" do not update themselves (e.g. builds for a package manager)
if (edition.updates) autoUpdater.setFeedURL({ ...edition.updates });
// Updates load in the background and install on the next quit: or right away when the
// user chooses "restart now" in the banner of the main window.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const updateScheduler = createUpdateScheduler({
    // The app and the chat on their own: a chat update needs no new installer
    checkForUpdates: async () => {
        const chatUpdate = chatBundles.checkForUpdate({ running: [...runningChatVersions].at(-1) || null });
        try {
            if (edition.updates && app.isPackaged) await autoUpdater.checkForUpdates();
        } finally {
            await chatUpdate;
        }
    },
    logger: log,
    onReady: (update) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-ready', update);
    },
});

autoUpdater.on('update-available', (info) => log.info(`Update ${info?.version} available, downloading in the background`));
autoUpdater.on('update-not-available', () => log.info('No update available'));
autoUpdater.on('update-downloaded', (info) => updateScheduler.markDownloaded(info));
autoUpdater.on('error', (err) => log.warn('Updater error:', err?.message || err));

let splashWindow;
let mainWindow;
let isIframeLoaded = false;
let activeProfileHash = null;
const unreadByProfile = new Map();
const sessionTokens = new Map(); // profileHash -> chat token of the running session (also without "remember me")

const nativeSockets = new Map(); // profileHash -> { socket, connectionId, buffer }
const sessionTrustedCerts = new Map(); // profileHash:host:port -> fingerprint

function certErrorCode(code) {
    return [
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'CERT_HAS_EXPIRED',
        'ERR_TLS_CERT_ALTNAME_INVALID',
    ].includes(code || '');
}

function trustKey(profileHash, host, port) {
    return `${profileHash}:${host}:${port}`;
}

function normalizeFingerprint(input) {
    return String(input || '').toUpperCase().replace(/[^A-F0-9]/g, '');
}

function getPersistedCertTrust(profileHash, host, port) {
    const trust = appStore.get('nativeSocketTrustedCerts', {});
    return normalizeFingerprint(trust?.[profileHash]?.[`${host}:${port}`]);
}

function persistCertTrust(profileHash, host, port, fingerprint) {
    const trust = appStore.get('nativeSocketTrustedCerts', {});
    trust[profileHash] = trust[profileHash] || {};
    trust[profileHash][`${host}:${port}`] = normalizeFingerprint(fingerprint);
    appStore.set('nativeSocketTrustedCerts', trust);
}

/** Same text as the chat sends on logout (DEFAULT_QUIT_MESSAGE in src/core/irc-protocol.js). */
const QUIT_MESSAGE = edition.chat.defaultQuitMessage || 'Avoid staring into the cosmic void. It might stare back at you.';
const QUIT_GRACE_MS = 1000;

/**
 * App quits: send QUIT on every open IRC socket and wait briefly for the server to close it,
 * so other users see the quit message instead of "Connection closed".
 */
function quitNativeSockets() {
    const pending = [...nativeSockets.entries()].map(([profileHash, entry]) => new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { clearNativeSocket(profileHash); resolve(); }, QUIT_GRACE_MS);
        try {
            if (!entry.socket.writable) return done();
            entry.socket.once('close', done);
            entry.socket.end(`QUIT :${entry.quitMessage || QUIT_MESSAGE}\r\n`);
        } catch (e) {
            log.warn('Failed to send QUIT on native socket:', e.message);
            done();
        }
    }));
    return Promise.all(pending).then(() => {
        for (const profileHash of nativeSockets.keys()) clearNativeSocket(profileHash);
    });
}

function clearNativeSocket(profileHash) {
    const entry = nativeSockets.get(profileHash);
    if (!entry) return;
    try {
        entry.socket.destroy();
    } catch (e) {
        log.warn('Failed to destroy native socket:', e.message);
    }
    nativeSockets.delete(profileHash);
}

function emitNativeSocketEvent(profileHash, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('native-socket-event', { profileHash, ...payload });
}

function parseIrcChunks(profileHash, connectionId, chunk) {
    const entry = nativeSockets.get(profileHash);
    if (!entry || entry.connectionId !== connectionId) return;
    //log.info(`[native-socket] recv ${profileHash} (${connectionId}): ${chunk.toString('utf8').replace(/\r?\n/g, ' | ').slice(0, 300)}`);
    entry.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = entry.buffer.indexOf('\n')) !== -1) {
        const line = entry.buffer.slice(0, idx).replace(/\r$/, '');
        entry.buffer = entry.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        emitNativeSocketEvent(profileHash, { connectionId, type: 'message', data: line });
    }
}

function probeCertificate(host, port) {
    return new Promise((resolve) => {
        log.info(`[native-socket] probing certificate ${host}:${port}`);
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
            const cert = socket.getPeerCertificate(true);
            resolve(cert || null);
            socket.end();
        });
        socket.on('error', () => resolve(null));
        socket.on('timeout', () => {
            socket.destroy();
            resolve(null);
        });
    });
}

async function promptCertificateTrust(profileHash, host, port, code) {
    const cert = await probeCertificate(host, port);
    const fp = normalizeFingerprint(cert?.fingerprint256 || cert?.fingerprint || '');
    if (!fp) return null;

    const message = `TLS certificate validation failed for ${host}:${port} (${code || 'unknown'}).`;
    const detail = `Fingerprint: ${cert.fingerprint256 || cert.fingerprint || 'unknown'}

You can reject, trust for this session, or trust permanently for this profile.`;

    const response = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Reject', 'Trust once', 'Always trust'],
        defaultId: 0,
        cancelId: 0,
        title: 'TLS Certificate Warning',
        message,
        detail,
        noLink: true,
    });

    if (response === 2) {
        persistCertTrust(profileHash, host, port, fp);
        return fp;
    }

    if (response === 1) {
        sessionTrustedCerts.set(trustKey(profileHash, host, port), fp);
        return fp;
    }

    return null;
}

function registerNativeSocket(profileHash, connectionId, socket) {
    clearNativeSocket(profileHash);
    nativeSockets.set(profileHash, { socket, connectionId, buffer: '' });

    socket.on('data', (chunk) => parseIrcChunks(profileHash, connectionId, chunk));
    socket.on('end', () => {
        log.info(`[native-socket] socket end (server sent FIN) ${profileHash} (${connectionId})`);
    });
    socket.on('close', (hadError) => {
        log.info(`[native-socket] socket close ${profileHash} (${connectionId}) hadError=${hadError}`);
        const current = nativeSockets.get(profileHash);
        if (current?.connectionId === connectionId) {
            nativeSockets.delete(profileHash);
        }
        emitNativeSocketEvent(profileHash, { connectionId, type: 'close' });
    });
    socket.on('error', (err) => {
        log.warn(`[native-socket] socket error ${profileHash} (${connectionId}): ${err?.message || 'socket error'}`);
        emitNativeSocketEvent(profileHash, { connectionId, type: 'error', error: err?.message || 'socket error' });
    });
}

function createPlainSocket({ profileHash, connectionId, host, port }) {
    log.info(`[native-socket] connect plain ${profileHash} ${host}:${port} (${connectionId})`);
    const socket = net.connect({ host, port });
    const connectTimer = setTimeout(() => socket.destroy(new Error('connect timeout')), 15000);

    registerNativeSocket(profileHash, connectionId, socket);
    socket.once('connect', () => {
        clearTimeout(connectTimer);
        log.info(`[native-socket] tcp connected ${profileHash} ${host}:${port} (${connectionId})`);
        emitNativeSocketEvent(profileHash, { connectionId, type: 'open' });
    });
}

async function createTlsSocket({ profileHash, connectionId, host, port }) {
    const persisted = getPersistedCertTrust(profileHash, host, port);
    const sessionTrust = sessionTrustedCerts.get(trustKey(profileHash, host, port));
    const pinnedFingerprint = normalizeFingerprint(sessionTrust || persisted);

    log.info(`[native-socket] connect tls ${profileHash} ${host}:${port} (${connectionId})`);
    const socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: !pinnedFingerprint,
    });
    const connectTimer = setTimeout(() => socket.destroy(new Error('connect timeout')), 15000);

    registerNativeSocket(profileHash, connectionId, socket);

    socket.once('secureConnect', () => {
        clearTimeout(connectTimer);
        log.info(`[native-socket] tls connected ${profileHash} ${host}:${port} (${connectionId})`);
        const cert = socket.getPeerCertificate(true);
        const currentFp = normalizeFingerprint(cert?.fingerprint256 || cert?.fingerprint || '');

        if (pinnedFingerprint && currentFp !== pinnedFingerprint) {
            emitNativeSocketEvent(profileHash, {
                connectionId,
                type: 'error',
                error: 'TLS fingerprint changed; connection rejected',
            });
            socket.destroy();
            return;
        }

        emitNativeSocketEvent(profileHash, { connectionId, type: 'open' });
    });

    socket.once('error', async (err) => {
        if (pinnedFingerprint || !certErrorCode(err?.code)) return;
        const trustedFingerprint = await promptCertificateTrust(profileHash, host, port, err?.code);
        if (!trustedFingerprint) return;

        const current = nativeSockets.get(profileHash);
        if (current?.connectionId !== connectionId) return;
        clearNativeSocket(profileHash);
        createTlsSocket({ profileHash, connectionId, host, port });
    });
}


const defaultNotificationSettings = {
    notifyDmPopup: true,
    notifyMentionPopup: true,
    notifyAnyWhenMinimized: false,
};

function getNotificationSettings() {
    return {
        ...defaultNotificationSettings,
        ...(appStore.get('notificationSettings', {}) || {}),
    };
}

function setNotificationSettings(settings = {}) {
    const merged = {
        ...defaultNotificationSettings,
        ...(settings || {}),
    };
    appStore.set('notificationSettings', merged);
    return merged;
}

const DEFAULT_PLAYER_SETTINGS = {
    volume: 80,
    muted: false,
    shuffle: false,
    repeat: 'none',
    richPresence: false,
    systemMediaRichPresence: false,
    streamUrl: 'https://stream.laut.fm/isnradio',
    lastStreamUrl: 'https://stream.laut.fm/isnradio',
    playlist: [],
    lastLoadedFiles: [],
    currentIndex: -1,
};

function getPlayerSettings() {
    return {
        ...DEFAULT_PLAYER_SETTINGS,
        ...(appStore.get('playerSettings', {}) || {}),
    };
}

function setPlayerSettings(settings = {}) {
    const merged = { ...DEFAULT_PLAYER_SETTINGS, ...(settings || {}) };
    appStore.set('playerSettings', merged);
    return merged;
}

function fetchStreamMetadataFromIcy(streamUrl, redirectDepth = 0) {
    return new Promise((resolve, reject) => {
        if (redirectDepth > 5) {
            resolve(null);
            return;
        }

        let parsed;
        try {
            parsed = new URL(streamUrl);
        } catch {
            resolve(null);
            return;
        }

        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(streamUrl, {
            timeout: 6000,
            headers: {
                'Icy-MetaData': '1',
                'User-Agent': USER_AGENT,
            },
        }, (res) => {
            if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (!location) {
                    resolve(null);
                    res.resume();
                    return;
                }

                const redirectedUrl = new URL(location, streamUrl).toString();
                res.resume();
                fetchStreamMetadataFromIcy(redirectedUrl, redirectDepth + 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            const metaInt = Number(res.headers['icy-metaint'] || 0);
            if (!metaInt || Number.isNaN(metaInt)) {
                resolve(null);
                res.resume();
                return;
            }

            let audioBytesUntilMeta = metaInt;
            let metaBytesNeeded = null;
            let metaBuffer = Buffer.alloc(0);

            const done = (value) => {
                try { req.destroy(); } catch {}
                resolve(value);
            };

            res.on('data', (chunk) => {
                let buf = chunk;
                while (buf.length > 0) {
                    if (metaBytesNeeded === null) {
                        if (audioBytesUntilMeta > 0) {
                            const skip = Math.min(audioBytesUntilMeta, buf.length);
                            audioBytesUntilMeta -= skip;
                            buf = buf.slice(skip);
                            if (buf.length === 0) return;
                        }
                        metaBytesNeeded = buf[0] * 16;
                        buf = buf.slice(1);
                        metaBuffer = Buffer.alloc(0);
                        if (metaBytesNeeded === 0) {
                            audioBytesUntilMeta = metaInt;
                            metaBytesNeeded = null;
                        }
                        continue;
                    }

                    const take = Math.min(metaBytesNeeded, buf.length);
                    metaBuffer = Buffer.concat([metaBuffer, buf.slice(0, take)]);
                    buf = buf.slice(take);
                    metaBytesNeeded -= take;

                    if (metaBytesNeeded === 0) {
                        const text = metaBuffer.toString('utf8').replace(/\0+$/g, '');
                        const match = /StreamTitle='([^']*)';/i.exec(text);
                        if (match && match[1]) {
                            const raw = match[1].trim();
                            const [artist, title] = raw.includes(' - ')
                                ? raw.split(' - ', 2)
                                : ['', raw];
                            done({
                                title: title || raw,
                                artist: artist || '',
                                album: '',
                                source: 'icy',
                            });
                            return;
                        }
                        audioBytesUntilMeta = metaInt;
                        metaBytesNeeded = null;
                    }
                }
            });

            res.on('end', () => resolve(null));
        });

        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

/**
 * Returns the chat token for a profile, or null: the stored (encrypted) one, otherwise
 * the token of the running session, so Spotify also works without "remember me".
 * Used by Spotify IPC handlers that need to call the API of the primary server.
 */
function getDecryptedToken(profileHash) {
    const profiles = appStore.get('profiles', []);
    const profile = profiles.find(p => p.hash === profileHash);
    if (!credentialsAllowed(profile)) return null;
    if (profile?.encryptedToken && safeStorage.isEncryptionAvailable()) {
        try {
            const token = safeStorage.decryptString(Buffer.from(profile.encryptedToken, 'hex')).trim();
            if (token) return token;
        } catch {
            // fall through to the session token
        }
    }
    return sessionTokens.get(profileHash) || null;
}

// ─── Spotify API helpers ──────────────────────────────────────────────────────

function spotifyApiHeaders(token) {
    return { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
}

/** API of the primary server when it offers Spotify (discovery feature "spotify"), else null. */
async function spotifyApiUrl(endpoint) {
    if (!(await primaryDiscovery.hasFeature('spotify'))) return null;
    return `${await primaryDiscovery.apiBaseUrl()}/spotify/${endpoint}`;
}

/**
 * Fetches the currently playing Spotify track via the API of the primary server.
 * The server holds the OAuth refresh token and proxies the Spotify API call.
 */
ipcMain.handle('player-get-system-media', async (event, profileHash) => {
    if (!profileHash) return null;
    const token = getDecryptedToken(profileHash);
    if (!token) return null;

    const url = await spotifyApiUrl('current-track');
    if (!url) return null;

    try {
        const resp = await fetch(url, {
            headers: spotifyApiHeaders(token),
        });
        if (!resp.ok) { log.debug('[Spotify] current-track HTTP', resp.status); return null; }
        const data = await resp.json();
        log.debug('[Spotify] current-track:', data);
        // The server answers {} when nothing is playing
        return data?.title ? { artist: data.artist || '', title: data.title } : null;
    } catch (err) {
        log.warn('[Spotify] current-track fetch error:', err.message);
        return null;
    }
});

/**
 * Spotify link of a profile: { available, connected }. available: the primary server offers
 * the feature "spotify" (the account may still need a login for the status).
 */
ipcMain.handle('spotify-status', async (event, profileHash) => {
    const url = await spotifyApiUrl('status');
    if (!url) return { available: false, connected: false };
    const token = profileHash ? getDecryptedToken(profileHash) : null;
    if (!token) return { available: true, connected: false };

    try {
        const resp = await fetch(url, {
            headers: spotifyApiHeaders(token),
        });
        const data = resp.ok ? await resp.json() : null;
        return { available: true, connected: data?.connected === true };
    } catch {
        return { available: true, connected: false };
    }
});

/**
 * Returns a Spotify OAuth URL (signed one-time link from the server).
 * The Electron client opens this in the system browser.
 */
ipcMain.handle('spotify-auth-url', async (event, profileHash) => {
    if (!profileHash) return null;
    const token = getDecryptedToken(profileHash);
    if (!token) return null;

    const url = await spotifyApiUrl('auth-url');
    if (!url) return null;

    try {
        const resp = await fetch(url, {
            headers: spotifyApiHeaders(token),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.url ?? null;
    } catch {
        return null;
    }
});

/** Returns the base app URL (without /app suffix) for use in the renderer. */
ipcMain.handle('get-app-url', () => (edition.chat.primaryServer ? `https://${edition.chat.primaryServer}` : ''));

/** Removes the Spotify link for the given profile's account. */
ipcMain.handle('spotify-disconnect', async (event, profileHash) => {
    if (!profileHash) return;
    const token = getDecryptedToken(profileHash);
    if (!token) return;

    const url = await spotifyApiUrl('disconnect');
    if (!url) return;

    try {
        await fetch(url, {
            method: 'DELETE',
            headers: spotifyApiHeaders(token),
        });
    } catch (err) {
        log.warn('[Spotify] disconnect error:', err.message);
    }
});

ipcMain.handle('player-fetch-stream-metadata', async (event, streamUrl) => {
    if (!streamUrl) return null;

    try {
        return await fetchStreamMetadataFromIcy(streamUrl);
    } catch (err) {
        log.warn('player-fetch-stream-metadata failed:', err.message);
        return null;
    }
});

async function readTrackMetadata(filePaths) {
    const tracks = [];
    for (const filePath of filePaths) {
        try {
            const meta = await parseFile(filePath, { skipCovers: true, duration: true });
            tracks.push({
                path:     filePath,
                title:    meta.common.title   || path.basename(filePath, path.extname(filePath)),
                artist:   meta.common.artist  || '',
                album:    meta.common.album   || '',
                duration: meta.format.duration || 0,
                type:     'local',
            });
        } catch {
            tracks.push({
                path:     filePath,
                title:    path.basename(filePath, path.extname(filePath)),
                artist:   '', album: '', duration: 0, type: 'local',
            });
        }
    }
    return tracks;
}

function createUnreadOverlayIcon() {
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
            <circle cx="16" cy="16" r="11" fill="#ff3b30" />
        </svg>`;
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    if (icon.isEmpty()) {
        return nativeImage.createEmpty();
    }
    return icon.resize({ width: 16, height: 16 });
}

function getTotalUnreadCount() {
    return Array.from(unreadByProfile.values()).reduce((sum, value) => sum + value, 0);
}

function updateTaskbarOverlay() {
    if (!mainWindow || process.platform !== 'win32') return;

    const totalUnread = getTotalUnreadCount();
    if (totalUnread > 0) {
        mainWindow.setOverlayIcon(createUnreadOverlayIcon(), `${totalUnread} unread messages`);
        return;
    }

    mainWindow.setOverlayIcon(null, 'No unread messages');
}

// ---------------- Fenster / AutoUpdater ----------------

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 350,
        height: 450,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: APP_ICON,
    });

    splashWindow.loadFile(path.join(__dirname, 'html/splash.html'))
        .then(() => {
            log.info('Splash window loaded');
            splashWindow?.show();
            splashWindow?.focus();
            splashWindow?.webContents?.send('update-status', 'splash_initializing');
            // No waiting for the update server: updates are checked in the background
            if (app.isPackaged) {
                updateScheduler.start();
            } else {
                log.info('App is not packaged (dev mode), skipping updates');
                splashWindow?.webContents?.send('update-status', 'splash_dev_mode');
            }
            proceedToMainWindow();
        })
        .catch(err => log.error('Failed to load splash window:', err));

    splashWindow.center();
    splashWindow.show();
    splashWindow.focus();
}

function createMainWindow() {
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const saved = appStore.get('windowBounds', null);
    const shouldMaximize = appStore.get('windowMaximized', true);
    const winWidth = (saved && saved.width) || workArea.width;
    const winHeight = (saved && saved.height) || workArea.height;
    const winOptions = {};
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        winOptions.x = saved.x;
        winOptions.y = saved.y;
    } else if (!shouldMaximize) {
        // Center the window if no saved position
        winOptions.x = Math.round((workArea.width - winWidth) / 2);
        winOptions.y = Math.round((workArea.height - winHeight) / 2);
    }
    const iconPath = APP_ICON;

    log.info('Loading icon from:', iconPath);
    log.info('Icon exists:', require('fs').existsSync(iconPath));
    mainWindow = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        ...winOptions,
        resizable: true,
        title: APP_NAME,
        frame: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: [`--user-agent=${APP_NAME}`]
        },
        icon: iconPath,
        show: false,
    });

    // Enable dev tools in dev mode
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    // Intercept native window close -> show confirmation in renderer
    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.webContents.send('confirm-close');
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'html/index.html'))
        .then(() => {
            log.info('Main window loaded, waiting for iframe...');
            splashWindow?.webContents?.send('update-status', 'splash_loading_app');
        })
        .catch(err => log.error('Failed to load main window:', err));

    // Chat iframes (direct children of the shell) may only show bundled files.
    // Nested frames (e.g. YouTube players inside the chat) are untouched.
    mainWindow.webContents.on('will-frame-navigate', (details) => {
        if (details.isMainFrame) return;
        if (details.frame?.parent && details.frame.parent !== mainWindow.webContents.mainFrame) return;
        const { url } = details;
        if (url === 'about:blank' || isBundledFileUrl(url)) return;
        log.warn(`Blocked iframe navigation to ${String(url).slice(0, 200)}`);
        details.preventDefault();
        openExternalSafely(url);
    });

    function saveWindowBounds() {
        if (!mainWindow) return;
        const isMaximized = mainWindow.isMaximized();
        appStore.set('windowMaximized', isMaximized);
        if (!isMaximized) {
            appStore.set('windowBounds', mainWindow.getBounds());
        }
    }

    mainWindow.on('resize', saveWindowBounds);
    mainWindow.on('move', saveWindowBounds);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.on('focus', () => {
        mainWindow.flashFrame(false);
    });
}

// ---------------- Updates (see updates.js) ----------------

/** The main window asks on load whether an update is already waiting. */
ipcMain.handle('get-pending-update', () => updateScheduler.pendingUpdate());

/** "Restart now" in the update banner. */
ipcMain.on('install-update', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !updateScheduler.pendingUpdate()) return;
    log.info(`Installing update ${updateScheduler.pendingUpdate().version} on user request`);
    app.isQuitting = true; // skip the close confirmation
    updateScheduler.stop();
    autoUpdater.quitAndInstall(true, true);
});

function showCustomNotification(title, body, avatarUrl = null) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    const notifWindow = new BrowserWindow({
        width: 320,
        height: 80,
        x: width - 330,
        y: height - 90,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    notifWindow.setIgnoreMouseEvents(false);
    notifWindow.loadFile(path.join(__dirname, 'html/notification.html'));

    notifWindow.webContents.once('did-finish-load', () => {
        notifWindow.webContents.send('notification-data', { title, body, avatarUrl });
        // Slide in
        notifWindow.showInactive();

        // Auto-close nach 4 Sekunden
        setTimeout(() => {
            if (!notifWindow.isDestroyed()) notifWindow.close();
        }, 4000);
    });

    // Klick auf die Notification -> App fokussieren
    ipcMain.once('notification-clicked', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
        if (!notifWindow.isDestroyed()) notifWindow.close();
    });
}

function proceedToMainWindow() {
    if (!mainWindow) {
        log.info('Proceeding to main window creation');
        createMainWindow();
    }
}

// ---------------- irc:// and ircs:// links (see irc-links.js) ----------------

/** A link that came before the main window could take it (app start, splash). */
let pendingIrcLink = ircUrlFromArgs(process.argv);

/** macOS hands links over with an event, also before the app is ready */
app.on('open-url', (event, url) => {
    if (!/^ircs?:\/\//i.test(String(url))) return;
    event.preventDefault();
    handleIrcLink(url);
});

/**
 * Registers the app for irc:// and ircs:// unless another IRC client already handles them
 * (installed builds only, a dev run keeps the system's handler). Users of mIRC or HexChat
 * keep their client for links.
 */
function registerIrcLinkHandler() {
    if (!app.isPackaged) return;
    for (const scheme of IRC_SCHEMES) {
        if (app.isDefaultProtocolClient(scheme)) continue;
        const current = app.getApplicationNameForProtocol(`${scheme}://`);
        if (current) {
            log.info(`${scheme}:// stays with ${current}`);
            continue;
        }
        if (!app.setAsDefaultProtocolClient(scheme)) log.warn(`Could not register as handler for ${scheme}://`);
    }
}

function handleIrcLink(url) {
    pendingIrcLink = url;
    deliverIrcLink();
}

/**
 * Tells the shell which tab the link opens, or the server for the "new connection" dialog.
 * Waits until the main window shows its chats.
 */
function deliverIrcLink() {
    if (!pendingIrcLink || !mainWindow || mainWindow.isDestroyed() || !isIframeLoaded) return;
    const link = parseIrcUrl(pendingIrcLink);
    pendingIrcLink = null;
    if (!link) return;
    const profile = profileForLink(appStore.get('profiles', []), link, edition.chat.primaryServer, activeProfileHash);
    log.info(`irc link to ${link.host}${link.channel ? ` ${link.channel}` : ''}: ${profile ? `profile ${profile.hash}` : 'new connection'}`);
    mainWindow.webContents.send('irc-link', profile
        ? { profileHash: profile.hash, channel: link.channel }
        : { server: link });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function showMainWindow() {
    if (mainWindow && isIframeLoaded) {
        log.info('Showing main window and closing splash');
        // Maximize before show to prevent flash of unmaximized window on Windows
        if (appStore.get('windowMaximized', true) && !mainWindow.isMaximized()) {
            mainWindow.maximize();
        }
        mainWindow.show();
        mainWindow.focus();
        mainWindow.setSkipTaskbar(false);
        const iconPath = APP_ICON;
        mainWindow.setIcon(iconPath);
        if (splashWindow) {
            splashWindow.close();
            splashWindow = null;
        }
        deliverIrcLink();
    } else {
        log.warn('Cannot show main window yet: mainWindow exists=', !!mainWindow, 'isIframeLoaded=', isIframeLoaded);
    }
}


function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (err) {
        return null;
    }
}

function getJwtMeta(token) {
    const payload = decodeJwtPayload(token);
    if (!payload) {
        return { validStructure: false, exp: null, iat: null, iss: null, sub: null, nickname: null, expired: null };
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = Number.isFinite(payload.exp) ? payload.exp : null;

    return {
        validStructure: true,
        exp,
        iat: Number.isFinite(payload.iat) ? payload.iat : null,
        iss: typeof payload.iss === 'string' ? payload.iss : null,
        sub: typeof payload.sub === 'string' ? payload.sub : null,
        nickname: typeof payload.nickname === 'string' ? payload.nickname : null,
        expired: exp !== null ? exp <= now : null,
        now,
    };
}

// ---------------- Verbindung / Profile / Tokens ----------------

// checkConnection loads the standalone chat directly (no server roundtrip).
// API features re-enable themselves when the server becomes reachable.
const checkConnection = (profileHash, token = null) => {
    const normalizedToken = typeof token === 'string' ? token.trim() : null;

    const profiles = appStore.get('profiles', []);
    const profile = profiles.find(p => p.hash === profileHash);
    const isExternal = profile?.serverType === 'external';

    log.info(`Loading standalone chat for profile ${profileHash} (external: ${isExternal})`);

    // Always load standalone: no HEAD request, instant start
    loadStandaloneOrOffline(profileHash, profile, isExternal, normalizedToken);
};

// Load the chat page (generated/chat or a signed update) if available, otherwise fall back to offline page
async function loadStandaloneOrOffline(profileHash, profile, isExternal, token) {
    const activeChat = chatBundles.activeChat();
    const standalonePath = path.join(activeChat.dir, 'index.html');
    const ext = profile?.externalServer || {};
    const connectionType = isExternal ? (ext.connectionType || 'websocket') : 'websocket';
    const hasConnection = isExternal
        ? (connectionType === 'socket' ? (!!ext.host && !!ext.port) : !!ext.websocketUrl)
        : true;

    if (hasConnection && fsSync.existsSync(standalonePath)) {
        log.info(`Loading standalone chat for profile ${profileHash}`);
        // A profile from before the network domain was stored looks it up in the directory
        if (isExternal && !ext.domain && startupDirectorySync) await startupDirectorySync;

        // Determine auth method and credentials for home profiles
        let homeAuthMethod = 'ircv3bearer';
        let homeSaslUsername = '';
        let homeSaslPassword = null;
        let homeNickname = profile?.name || 'Guest';
        let apiToken = token || '';

        if (!isExternal && profile?.saslUsername) {
            const decryptedPw = getDecryptedSaslPassword(profileHash);
            if (decryptedPw) {
                homeAuthMethod = 'sasl_plain';
                homeSaslUsername = profile.saslUsername;
                homeSaslPassword = decryptedPw;

                // Fetch API token for community/friends features
                try {
                    const apiBaseUrl = await primaryDiscovery.apiBaseUrl();
                    if (!apiBaseUrl) throw new Error('the primary server offers no API');
                    const resp = await fetch(`${apiBaseUrl}/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                        body: JSON.stringify({ username: homeSaslUsername, password: decryptedPw }),
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.token) {
                            apiToken = data.token;
                            log.info(`API token fetched for home SASL profile ${profileHash}`);
                        }
                    } else {
                        log.warn(`API login failed for home SASL profile ${profileHash}: HTTP ${resp.status}`);
                    }
                } catch (err) {
                    log.warn(`API login request failed for home SASL profile ${profileHash}:`, err.message);
                }
            }
            if (profile.nickname) homeNickname = profile.nickname;
        } else if (!isExternal && profile?.nickname) {
            homeNickname = profile.nickname;
        }

        // SASL profiles never go through save-credentials: keep their API token for Spotify & co.
        if (!isExternal && apiToken) sessionTokens.set(profileHash, apiToken);

        const externalSaslPassword = isExternal ? getDecryptedSaslPassword(profileHash) : null;
        const standaloneConfig = {
            locale: app.getLocale(),
            websocketUrl: isExternal ? (ext.websocketUrl || '') : '',
            connectionType: connectionType,
            nickname: isExternal ? (ext.nickname || 'Guest') : homeNickname,
            password: isExternal ? (token || '') : apiToken,
            isElectron: true,
            authenticated: true, // Always skip login in standalone: Electron shell handles auth
            authMethod: isExternal ? (ext.authMethod || 'none') : homeAuthMethod,
            isExternalServer: !!isExternal,
            defaultChannel: isExternal ? (ext.defaultChannel || '') : '',
            saslUsername: isExternal ? (ext.saslUsername || '') : homeSaslUsername,
            saslPassword: isExternal ? (externalSaslPassword || '') : (homeSaslPassword || ''),
            socketHost: isExternal ? (ext.host || null) : null,
            socketPort: isExternal ? (ext.port || null) : null,
            socketSsl: isExternal ? (ext.ssl !== false) : true,
            // Discovery (login, API, features) of the network: stored, or from the directory
            networkDomain: isExternal ? (ext.domain || directoryDomainFor(serverDirectory(), ext)) : '',
            networkName: isExternal ? (profile?.name || '') : '',
            profileHash,
        };
        if (activeChat.version) {
            runningChatVersions.add(activeChat.version);
            log.info(`Chat from update ${activeChat.version}`);
        }
        watchChatStart(profileHash, activeChat, () => loadStandaloneOrOffline(profileHash, profile, isExternal, token));

        mainWindow.webContents.send('set-iframe-src', {
            profileHash,
            src: `file://${standalonePath}`,
            isExternal,
            standalone: true,
            standaloneConfig,
        });
    } else {
        mainWindow.webContents.send('set-iframe-src', {
            profileHash,
            src: `file://${path.join(__dirname, 'html/offline.html')}`
        });
    }
}

// Helper: decrypt SASL password from store (supports both external and home profiles)
function getDecryptedSaslPassword(profileHash) {
    const profiles = appStore.get('profiles', []);
    const profile = profiles.find(p => p.hash === profileHash);
    if (!credentialsAllowed(profile)) return null;
    // Check external server password first, then home profile password
    const encrypted = profile?.externalServer?.encryptedSaslPassword || profile?.encryptedSaslPassword;
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
    try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'hex'));
    } catch (e) {
        log.error(`Failed to decrypt SASL password for profile ${profileHash}:`, e.message);
        return null;
    }
}

/**
 * A chat from a not yet confirmed update must come up in time: otherwise that update is
 * dropped for good and the profile loads the chat built into the app.
 */
function watchChatStart(profileHash, activeChat, reloadWithBuiltInChat) {
    const previous = pendingChatConfirmations.get(profileHash);
    if (previous) clearTimeout(previous.timer);
    pendingChatConfirmations.delete(profileHash);
    if (!activeChat.needsConfirmation) return;

    const timer = setTimeout(() => {
        pendingChatConfirmations.delete(profileHash);
        chatBundles.markFailed(activeChat.version);
        runningChatVersions.delete(activeChat.version);
        reloadWithBuiltInChat();
    }, CHAT_READY_TIMEOUT_MS);
    pendingChatConfirmations.set(profileHash, { version: activeChat.version, timer });
}

// The chat's script runs (it asked the shell for its settings): an update in use is confirmed
ipcMain.on('chat-ready', (event, { profileHash } = {}) => {
    if (event.sender !== mainWindow?.webContents) return;
    const pending = pendingChatConfirmations.get(profileHash);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingChatConfirmations.delete(profileHash);
    chatBundles.markReady(pending.version);
});

ipcMain.on('iframe-loaded', (event, { profileHash, success, src }) => {
    if (success) {
        log.info(`Iframe loaded successfully for profile ${profileHash}`);
        isIframeLoaded = true;
        showMainWindow();
    } else {
        log.warn(`Iframe failed/offline for profile ${profileHash}: ${src}`);
        // Auch im Offline-Fall: App anzeigen, nicht im Splash hängen
        isIframeLoaded = true;
        showMainWindow();
    }
});

// Profile laden
ipcMain.handle('get-profiles', () => {
    let profiles = appStore.get('profiles');

    // Only an edition with a primary server starts with a profile; others let the user choose
    if ((!profiles || !profiles.length) && edition.chat.primaryServer) {
        profiles = [
            { hash: 'default', name: 'Default', loggingEnabled: true }
        ];
        appStore.set('profiles', profiles);
        log.info('Initialized profiles in appStore:', profiles);
    }
    profiles = profiles || [];

    // Felder normalisieren, die in älteren Profilen fehlen können
    return profiles.map(p => ({
        showServerWindow: false,
        ...p,
    }));
});

ipcMain.handle('force-close', () => {
    app.isQuitting = true;
    mainWindow.close();
});

app.on('before-quit', (e) => {
    if (app.isQuitting) {
        if (nativeSockets.size > 0 && !app.nativeSocketsQuit) {
            e.preventDefault();
            app.nativeSocketsQuit = true;
            quitNativeSockets().finally(() => app.quit());
        }
        return;
    }
    if (!app.isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        e.preventDefault();
        mainWindow.webContents.send('confirm-close');
    }
});

// Profile speichern (per invoke)
/**
 * The profile list changed (main window tabs, profile manager): every other window
 * re-reads it, so no window keeps (and later saves back) a stale list.
 */
function notifyProfilesChanged(sender) {
    BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send('profiles-changed');
    });
}

ipcMain.handle('save-profiles', (event, profiles) => {
    try {
        // Credentials and the bound server come from the store, never from the window
        const mergedProfiles = mergeShellProfiles(appStore.get('profiles', []), profiles, edition.chat.primaryServer || '');
        appStore.set('profiles', mergedProfiles);
        // No profile contents in the log: they carry (encrypted) credentials
        log.info(`Saved ${mergedProfiles.length} profile(s) to appStore`);
        notifyProfilesChanged(event.sender);
        return { ok: true };
    } catch (err) {
        log.error('Failed to save profiles to appStore:', err);
        return { ok: false, error: err.message };
    }
});


ipcMain.on('native-socket-connect', async (event, payload = {}) => {
    const { profileHash, connectionId, host, port, ssl } = payload;
    const existing = nativeSockets.get(profileHash);
    if (existing && existing.connectionId === connectionId) {
        log.info(`[native-socket] duplicate connect ignored ${profileHash} (${connectionId})`);
        return;
    }
    if (!profileHash || !connectionId || !host || !Number(port)) {
        emitNativeSocketEvent(profileHash || 'unknown', {
            connectionId: connectionId || 'unknown',
            type: 'error',
            error: 'Invalid native socket connect payload',
        });
        return;
    }

    // Only the host/port stored in this profile may be dialed: never an arbitrary target.
    const ext = (appStore.get('profiles', []) || []).find(p => p.hash === profileHash)?.externalServer;
    if (!isConfiguredSocketTarget(ext, host, port)) {
        log.warn(`[native-socket] connect refused: ${host}:${port} is not the configured server of profile ${profileHash}`);
        emitNativeSocketEvent(profileHash, {
            connectionId,
            type: 'error',
            error: 'Target does not match the profile configuration',
        });
        return;
    }

    try {
        if (ssl) {
            await createTlsSocket({ profileHash, connectionId, host, port: Number(port) });
        } else {
            createPlainSocket({ profileHash, connectionId, host, port: Number(port) });
        }
    } catch (err) {
        emitNativeSocketEvent(profileHash, {
            connectionId,
            type: 'error',
            error: err?.message || 'connect failed',
        });
    }
});

ipcMain.on('native-socket-send', (event, payload = {}) => {
    const { connectionId, line, profileHash, quitMessage } = payload;
    const entry = nativeSockets.get(profileHash);
    // Not a line to send: the text this socket quits with when the app is closed
    if (typeof quitMessage === 'string') {
        if (entry && entry.connectionId === connectionId) {
            entry.quitMessage = sanitizeIrcLine(quitMessage).slice(0, 200);
        }
        return;
    }
    if (!entry || entry.connectionId !== connectionId || !entry.socket || entry.socket.destroyed || !entry.socket.writable) {
        log.warn(`[native-socket] send DROPPED (${connectionId}): ${redactIrcLine(line)} (socket missing or not writable)`);
        return;
    }
    entry.socket.write(`${sanitizeIrcLine(line)}\r\n`);
});

ipcMain.on('native-socket-close', (event, payload = {}) => {
    const { connectionId, profileHash } = payload;
    const entry = nativeSockets.get(profileHash);
    if (entry && entry.connectionId === connectionId) {
        clearNativeSocket(profileHash);
    }
});

// Profil laden
ipcMain.on('load-profile', (event, { hash, token }) => {

    log.info(`Loading profile ${hash} (token ${token ? 'provided' : 'none'})`);
    checkConnection(hash, token);
});

// Profil löschen
ipcMain.on('delete-profile', (event, profileHash) => deleteStoredProfile(profileHash, event.sender));

/** Remove a profile with everything stored for it (token, password, profile store, socket). */
function deleteStoredProfile(profileHash, sender = null) {
    log.info(`Deleting profile ${profileHash}`);

    // Token & Config aus dem Profil-Store entfernen + Datei loeschen
    const store = getStore(profileHash);
    store.clear();
    try {
        const storePath = store.path;
        stores.delete(profileHash);
        if (fsSync.existsSync(storePath)) {
            fsSync.unlinkSync(storePath);
            log.info(`Deleted profile store file: ${storePath}`);
        }
    } catch (e) {
        log.warn(`Could not delete profile store file for ${profileHash}:`, e.message);
    }

    // Token auch aus appStore-Profil entfernen
    let profiles = appStore.get('profiles', []);
    const idx = profiles.findIndex(p => p.hash === profileHash);
    if (idx !== -1) {
        delete profiles[idx].encryptedToken;
        profiles.splice(idx, 1);
        appStore.set('profiles', profiles);
        log.info(`Profile ${profileHash} removed from appStore.`);
    } else {
        log.warn(`delete-profile: profile ${profileHash} not found in appStore.`);
    }

    clearNativeSocket(profileHash);
    unreadByProfile.delete(profileHash);
    sessionTokens.delete(profileHash);
    updateTaskbarOverlay();
    notifyProfilesChanged(sender);
}

// Token speichern (zentral in appStore)
ipcMain.on('save-credentials', (event, { token, remember, profileHash }) => {
    let profiles = appStore.get('profiles', []);
    const idx = profiles.findIndex(p => p.hash === profileHash);

    if (idx === -1) {
        log.warn(`save-credentials for unknown profile ${profileHash}`);
        return;
    }

    const store = getStore(profileHash); // für evtl. alte Tokens

    const normalizedToken = typeof token === 'string' ? token.trim() : '';
    const tokenMeta = normalizedToken ? getJwtMeta(normalizedToken) : null;

    if (tokenMeta && tokenMeta.expired) {
        log.warn(`Refusing to persist expired token for ${profileHash}`, {
            now: tokenMeta.now,
            exp: tokenMeta.exp,
            iat: tokenMeta.iat,
            iss: tokenMeta.iss,
        });
    }

    if (normalizedToken && !(tokenMeta && tokenMeta.expired)) sessionTokens.set(profileHash, normalizedToken);
    else sessionTokens.delete(profileHash);

    if (!remember || !safeStorage.isEncryptionAvailable() || !normalizedToken || (tokenMeta && tokenMeta.expired)) {
        delete profiles[idx].encryptedToken;
        appStore.set('profiles', profiles);
        store.delete('chatToken');
        log.info(`Credentials not saved for ${profileHash} (remember=${remember}), encryptedToken cleared.`);
        return;
    }

    const encryptedToken = safeStorage.encryptString(normalizedToken).toString('hex');
    profiles[idx].encryptedToken = encryptedToken;
    appStore.set('profiles', profiles);

    // alten Token aus profile-Store entfernen (falls noch da)
    store.delete('chatToken');

    log.info(`Credentials saved in appStore for profile ${profileHash}`);
});

// SASL-Passwort verschlüsselt speichern
ipcMain.on('encrypt-sasl-password', (event, { profileHash, password }) => {
    if (!safeStorage.isEncryptionAvailable() || !password) {
        log.warn(`Cannot encrypt SASL password for ${profileHash}: safeStorage unavailable or empty password`);
        return;
    }

    const profiles = appStore.get('profiles', []);
    const idx = profiles.findIndex(p => p.hash === profileHash);
    if (idx === -1) {
        log.warn(`encrypt-sasl-password: profile ${profileHash} not found`);
        return;
    }

    if (!profiles[idx].externalServer) profiles[idx].externalServer = {};
    profiles[idx].externalServer.encryptedSaslPassword = safeStorage.encryptString(password).toString('hex');
    appStore.set('profiles', profiles);
    log.info(`SASL password encrypted and saved for profile ${profileHash}`);
});

// SASL-Passwort für Home-Profile verschlüsselt speichern (direkt am Profil-Objekt)
ipcMain.on('encrypt-home-sasl-password', (event, { profileHash, password }) => {
    if (!safeStorage.isEncryptionAvailable() || !password) {
        log.warn(`Cannot encrypt home SASL password for ${profileHash}: safeStorage unavailable or empty password`);
        return;
    }

    const profiles = appStore.get('profiles', []);
    const idx = profiles.findIndex(p => p.hash === profileHash);
    if (idx === -1) {
        log.warn(`encrypt-home-sasl-password: profile ${profileHash} not found`);
        return;
    }

    profiles[idx].encryptedSaslPassword = safeStorage.encryptString(password).toString('hex');
    appStore.set('profiles', profiles);
    log.info(`Home SASL password encrypted and saved for profile ${profileHash}`);
});

// API-Token per Login-Endpunkt abrufen (für Home-Profile mit SASL_PLAIN)
ipcMain.handle('fetch-api-token', async (event, { profileHash, username, password }) => {
    try {
        const apiBaseUrl = await primaryDiscovery.apiBaseUrl();
        if (!apiBaseUrl) return null;
        const resp = await fetch(`${apiBaseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
            body: JSON.stringify({ username, password }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.token) {
                log.info(`API token fetched via IPC for profile ${profileHash}`);
                return data.token;
            }
        }
        log.warn(`API login failed for profile ${profileHash}: HTTP ${resp.status}`);
        return null;
    } catch (err) {
        log.warn(`API login request failed for profile ${profileHash}:`, err.message);
        return null;
    }
});

// Token lesen (zentral aus appStore)
ipcMain.handle('get-token', (event, profileHash) => {
    const profiles = appStore.get('profiles', []);
    const profile = profiles.find(p => p.hash === profileHash);

    if (!profile || !profile.encryptedToken) {
        log.info(`No token found for profile ${profileHash} in appStore`);
        return null;
    }
    if (!credentialsAllowed(profile)) return null;

    if (!safeStorage.isEncryptionAvailable()) {
        log.warn('safeStorage not available, cannot decrypt token');
        return null;
    }

    try {
        const buffer = Buffer.from(profile.encryptedToken, 'hex');
        const token = safeStorage.decryptString(buffer).trim();
        const tokenMeta = getJwtMeta(token);

        if (!token || (tokenMeta.validStructure && tokenMeta.expired)) {
            log.warn(`Discarding stale token for profile ${profileHash}`, {
                validStructure: tokenMeta.validStructure,
                now: tokenMeta.now,
                exp: tokenMeta.exp,
                iat: tokenMeta.iat,
                iss: tokenMeta.iss,
            });
            delete profile.encryptedToken;
            appStore.set('profiles', profiles);
            return null;
        }

        log.info(`Retrieved token for profile ${profileHash}: exists`, {
            now: tokenMeta.now,
            exp: tokenMeta.exp,
            iat: tokenMeta.iat,
            iss: tokenMeta.iss,
        });
        return token;
    } catch (err) {
        log.warn(`Failed to decrypt token for profile ${profileHash}:`, err.message);

        // defekten Token entfernen
        delete profile.encryptedToken;
        appStore.set('profiles', profiles);

        return null;
    }
});

// Logout: Token aus appStore + altem Store löschen
ipcMain.on('logout', (event, profileHash) => {
    let profiles = appStore.get('profiles', []);
    const idx = profiles.findIndex(p => p.hash === profileHash);
    if (idx !== -1) {
        delete profiles[idx].encryptedToken;
        appStore.set('profiles', profiles);
        log.info(`Logged out, encryptedToken cleared for profile ${profileHash}`);
    } else {
        log.warn(`Logout requested for unknown profile ${profileHash}`);
    }

    const store = getStore(profileHash);
    store.delete('chatToken');

    sessionTokens.delete(profileHash);
    unreadByProfile.set(profileHash, 0);
    updateTaskbarOverlay();
    // The chat shows its login dialog itself, no reload
});

// ---------------- Mentions / Logging / Logs ----------------

ipcMain.on('mention-update', (event, { hasMentions, mentionCount, profileHash }) => {
    log.info(`mention-update received: hasMentions=${hasMentions}, count=${mentionCount}, profile=${profileHash}`);

    if (!mainWindow) {
        log.warn('mention-update: mainWindow is null');
        return;
    }

    if (hasMentions && mentionCount > 0) {
        if (!mainWindow.isFocused()) {
            log.info('Flashing taskbar frame');
            mainWindow.flashFrame(true);
        }

        if (process.platform === 'win32') {
            try {
                const badge = createBadgeOverlay(mentionCount);
                mainWindow.setOverlayIcon(badge, `${mentionCount} mentions`);
                log.info(`Set overlay icon with count ${mentionCount}`);
            } catch (err) {
                log.error('Failed to set overlay icon:', err);
            }
        }
    } else {
        mainWindow.flashFrame(false);
        if (process.platform === 'win32') {
            mainWindow.setOverlayIcon(null, '');
        }
    }
});

// Theme
ipcMain.handle('get-theme', () => {
    return appStore.get('theme', 'dark');
});

ipcMain.handle('save-theme', (event, value) => {
    appStore.set('theme', value);
    BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('theme-changed', value);
    });
    return { ok: true };
});

ipcMain.handle('get-notification-settings', () => {
    return getNotificationSettings();
});

ipcMain.handle('save-notification-settings', (event, settings) => {
    return setNotificationSettings(settings);
});

ipcMain.handle('player-get-settings', () => {
    return getPlayerSettings();
});

ipcMain.handle('player-save-settings', (event, settings) => {
    return setPlayerSettings(settings);
});

ipcMain.handle('player-open-files', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Musik hinzufügen',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Audio', extensions: ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'opus'] },
        ],
    });
    if (canceled || !filePaths.length) return [];
    return await readTrackMetadata(filePaths);
});

ipcMain.handle('player-scan-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Musik-Ordner hinzufügen',
        properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return [];

    const folder = filePaths[0];
    const audioExts = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.opus']);
    const found = [];

    async function scanDir(dir) {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) await scanDir(full);
                else if (audioExts.has(path.extname(e.name).toLowerCase())) found.push(full);
            }
        } catch (err) {
            log.warn('player-scan-folder error:', err.message);
        }
    }

    await scanDir(folder);
    return await readTrackMetadata(found);
});

ipcMain.on('incoming-message', (event, messageInfo = {}) => {
    const settings = getNotificationSettings();
    const {
        sender = 'Unknown',
        channel = 'Chat',
        text = '',
        isDm = false,
        isMention = false,
        profileHash = null,
    } = messageInfo;

    if (profileHash && !unreadByProfile.has(profileHash)) {
        unreadByProfile.set(profileHash, 0);
    }

    const shouldNotifyDm = settings.notifyDmPopup && isDm;
    const shouldNotifyMention = settings.notifyMentionPopup && isMention;
    const shouldNotifyAnyMinimized = settings.notifyAnyWhenMinimized && !mainWindow?.isFocused();

    if (shouldNotifyDm || shouldNotifyMention || shouldNotifyAnyMinimized) {
        const title = isDm
            ? `Neue DM von ${sender}`
            : (isMention ? `Ping von ${sender} in ${channel}` : `${sender} in ${channel}`);
        const body = text ? `${sender}: ${text}` : `${sender}: (keine Vorschau)`;
        const dedupKey = `${sender}:${channel}:${body}`;
        if (!isDuplicateNotification(dedupKey)) {
            showCustomNotification(title, body);
        }
    }
});

ipcMain.on('active-profile-changed', (event, { profileHash } = {}) => {
    if (!profileHash) return;
    activeProfileHash = profileHash;
});

ipcMain.on('unread-state-update', (event, { profileHash, totalUnread } = {}) => {
    if (!profileHash) return;
    const normalizedUnread = Number.isFinite(Number(totalUnread)) ? Math.max(0, Number(totalUnread)) : 0;
    const previousUnread = unreadByProfile.get(profileHash) || 0;
    const isUnreadDecrease = normalizedUnread < previousUnread;
    const hasFocusedTabContext = !!mainWindow && mainWindow.isFocused() && activeProfileHash === profileHash;

    if (isUnreadDecrease && !hasFocusedTabContext) {
        return;
    }
    unreadByProfile.set(profileHash, normalizedUnread);
    updateTaskbarOverlay();
});

ipcMain.on('unread-update', (event, { hasUnread }) => {
    if (!mainWindow || mainWindow.isFocused()) return;
    if (hasUnread) {
        mainWindow.flashFrame(true);
    }
});

ipcMain.on('log-chat', async (event, { channel, message, profileHash, loggingEnabled }) => {
    try {
        if (!channel || !message || !profileHash) {
            log.error(`Invalid log-chat data for profile ${profileHash || 'unknown'}`);
            return;
        }
        if (!loggingEnabled) {
            return;
        }
        const logDir = await getLogDir(profileHash, true);
        const date = new Date().toISOString().split('T')[0];
        const sanitizedChannel = channel.replace(/[^\p{L}\p{N}_-]/gu, '').toLowerCase();
        const logFileName = `${sanitizedChannel}-${date}.log`;
        const logPath = path.join(logDir, logFileName);
        await fs.appendFile(logPath, `${String(message).replace(/[\r\n]+/g, ' ')}\n`);
    } catch (err) {
        log.error(`Failed to log chat for profile ${profileHash}:`, err);
    }
});

ipcMain.handle('get-chat-logs', async (event, profileHash) => {
    const logDir = await getLogDir(profileHash);
    try {
        const date = new Date().toISOString().split('T')[0];
        const logFiles = await fs.readdir(logDir).catch(() => []);
        const logs = [];
        for (const file of logFiles) {
            if (file.endsWith(`${date}.log`)) {
                const logPath = path.join(logDir, file);
                const content = await fs.readFile(logPath, 'utf8');
                logs.push(`=== ${file} ===\n${content}\n`);
            }
        }
        return logs.length > 0 ? logs.join('\n') : 'No logs available';
    } catch (err) {
        log.error(`Error reading logs for profile ${profileHash}:`, err);
        return 'Failed to load logs';
    }
});

ipcMain.handle('reveal-log-file', async (event, { profileHash, filename }) => {
    try {
        if (!profileHash || !filename) {
            log.warn('reveal-log-file called without profileHash or filename');
            return false;
        }

        const logDir = await getLogDir(profileHash);
        const logPath = resolveLogFilePath(logDir, filename);
        if (!logPath) {
            log.warn(`reveal-log-file rejected invalid filename for profile ${profileHash}`);
            return false;
        }

        log.info(`Revealing log file in explorer: ${logPath}`);
        shell.showItemInFolder(logPath);

        return true;
    } catch (err) {
        log.error('Failed to reveal log file:', err);
        return false;
    }
});

ipcMain.handle('get-log-files', async (event, profileHash) => {
    const logDir = await getLogDir(profileHash);
    try {
        const files = await fs.readdir(logDir).catch(() => []);
        return files.filter(file => file.endsWith('.log'));
    } catch (err) {
        log.error(`Failed to list log files for profile ${profileHash}:`, err);
        return [];
    }
});

// ---------------- Sonstiges: External, Log-Pfad, Fenstersteuerung ----------------

ipcMain.on('open-external', (event, url) => {
    openExternalSafely(url);
});

ipcMain.handle('get-log-content', async (event, profileHash, filename) => {
    const logDir = await getLogDir(profileHash);
    try {
        const logPath = resolveLogFilePath(logDir, filename);
        if (!logPath) {
            log.warn(`get-log-content rejected invalid filename for profile ${profileHash}`);
            return 'Error loading log file';
        }
        return await fs.readFile(logPath, 'utf8');
    } catch (err) {
        log.error(`Failed to read log file for profile ${profileHash}:`, err);
        return 'Error loading log file';
    }
});

ipcMain.handle('get-log-path', async (event, profileHash) => {
    return await getLogDir(profileHash);
});

ipcMain.handle('change-log-path', async (event, profileHash) => {
    const store = getStore(profileHash);
    const result = await dialog.showOpenDialog({
        title: 'Select Log Directory',
        defaultPath: await getLogDir(profileHash),
        properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const newLogDir = result.filePaths[0];
        logDirs.set(profileHash, newLogDir);
        store.set('logDir', newLogDir);
        await fs.mkdir(newLogDir, { recursive: true }).catch(err => log.error(`Failed to create new log directory ${newLogDir}:`, err));
        return newLogDir;
    }
    return null;
});

ipcMain.on('retry-connection', () => {
    app.relaunch();
    app.exit(0);
});

// ─── Renderer error log (local only, copied by the user on demand) ─────────────

let rendererErrorLog = null;

function getRendererErrorLog() {
    if (!rendererErrorLog) {
        rendererErrorLog = createErrorLog({
            appName: APP_NAME,
            filePath: path.join(app.getPath('userData'), 'logs', 'renderer-errors.log'),
            fs: fsSync,
            dirname: path.dirname,
            logger: log,
        });
    }
    return rendererErrorLog;
}

ipcMain.on('renderer-error', (event, payload) => {
    getRendererErrorLog().record(payload);
});

ipcMain.handle('get-error-report-count', () => getRendererErrorLog().count());

ipcMain.handle('copy-error-report', () => {
    const errorLog = getRendererErrorLog();
    clipboard.writeText(errorLog.buildReport({
        version: app.getVersion(),
        electron: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
    }));
    return errorLog.count();
});

ipcMain.handle('clear-error-report', () => {
    getRendererErrorLog().clear();
    return 0;
});

app.on('render-process-gone', (event, webContents, details) => {
    if (details?.reason === 'clean-exit') return;
    getRendererErrorLog().record({
        kind: 'crash',
        source: 'main',
        message: `Renderer gone: ${details?.reason || 'unknown'} (exit code ${details?.exitCode ?? '?'})`,
        filename: webContents?.getURL?.() || '',
    });
});

// App-Version
ipcMain.handle('get-version', () => app.getVersion());

// Systemsprache zurückgeben (de, en, ...)
ipcMain.handle('get-locale', () => {
    const locale = app.getLocale(); // z.B. "de-DE", "en-US"
    return locale.split('-')[0].toLowerCase(); // → "de" oder "en"
});

// Übersetzungs-JSON für gegebene Locale laden
ipcMain.handle('get-translations', (event, locale) => {
    const supported = ['de', 'en'];
    const lang = supported.includes(locale) ? locale : 'en';
    const read = (language) => JSON.parse(fsSync.readFileSync(path.join(__dirname, 'locales', `${language}.json`), 'utf-8'));
    try {
        return shellTexts({ ...read('en'), ...read(lang) }, edition, lang);
    } catch (err) {
        log.error(`Failed to load locale file for "${lang}":`, err);
        return shellTexts(read('en'), edition, 'en');
    }
});

/** Name and pictures of the edition for the app windows. */
ipcMain.handle('get-edition-info', () => ({
    appName: APP_NAME,
    primaryServer: edition.chat.primaryServer || '',
    networkName: edition.chat.networkName,
    icon: '../generated/icon.png',
    splashImage: `../generated/${edition.splashImage}`,
}));

// Log viewer window (one at a time)
let logViewerWindow = null;

ipcMain.on('open-log-viewer', (event, profileHash) => {
    if (logViewerWindow && !logViewerWindow.isDestroyed()) {
        logViewerWindow.focus();
        return;
    }

    logViewerWindow = new BrowserWindow({
        width: 1100,
        height: 700,
        minWidth: 700,
        minHeight: 400,
        title: `${APP_NAME}: Log Viewer`,
        frame: false,
        backgroundColor: '#1a1d21',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: APP_ICON,
    });

    logViewerWindow.loadFile(
        path.join(__dirname, 'html/logs.html'),
        { query: { profile: profileHash || 'default' } }
    );

    logViewerWindow.on('closed', () => {
        logViewerWindow = null;
    });
});

/** Open a TCP/TLS or WebSocket connection to a server and close it again: nothing is sent. */
async function testServerConnection(payload = {}) {
    const startedAt = Date.now();
    const TIMEOUT_MS = 8000;

    if (payload.connectionType === 'websocket') {
        let url;
        try { url = new URL(String(payload.websocketUrl || '')); } catch { return { ok: false, reason: 'invalid' }; }
        if (!['wss:', 'ws:'].includes(url.protocol)) return { ok: false, reason: 'invalid' };
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
            let ws;
            try { ws = new WebSocket(url.href, ['text.ircv3.net']); } catch { return finish({ ok: false, reason: 'invalid' }); }
            const timer = setTimeout(() => { try { ws.close(); } catch {} finish({ ok: false, reason: 'timeout' }); }, TIMEOUT_MS);
            ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); finish({ ok: true, ms: Date.now() - startedAt }); });
            ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, reason: 'unknown' }); });
        });
    }

    const host = String(payload.host || '').trim();
    const port = Number(payload.port);
    if (!isValidConnectionTarget(host, port)) return { ok: false, reason: 'invalid' };

    return new Promise((resolve) => {
        const options = { host, port, timeout: TIMEOUT_MS };
        const socket = payload.ssl !== false
            ? tls.connect({ ...options, servername: host.replace(/^\[|\]$/g, ''), rejectUnauthorized: true })
            : net.connect(options);
        const done = (result) => { socket.destroy(); resolve(result); };
        socket.once(payload.ssl !== false ? 'secureConnect' : 'connect', () => done({ ok: true, ms: Date.now() - startedAt }));
        socket.once('timeout', () => done({ ok: false, reason: 'timeout' }));
        socket.once('error', (err) => done({ ok: false, reason: connectionErrorReason(err), code: err?.code || '' }));
    });
}

// ---------------- Connections page in the chat settings (see connections.js) ----------------
// The chat iframe asks through the shell (index.html), which is the only caller allowed here.
// The page is untrusted: it gets public profile views only and every change is validated.

const connectionTestLimiter = createTestLimiter();

/** Only the shell page of the main window: not the manager, not a frame inside it. */
function isShellRequest(event) {
    return Boolean(mainWindow) && !mainWindow.isDestroyed()
        && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame;
}

function connectionsList() {
    return (appStore.get('profiles', []) || []).map(profile => publicProfile(profile, edition.chat.networkName));
}

ipcMain.handle('connections-list', (event) => {
    if (!isShellRequest(event)) return { ok: false, reason: 'forbidden' };
    return { ok: true, profiles: connectionsList() };
});

ipcMain.handle('connections-save', (event, update = {}) => {
    if (!isShellRequest(event)) return { ok: false, reason: 'forbidden' };
    // New home connections are bound to the primary server (none without one)
    const result = applyConnectionUpdate(appStore.get('profiles', []) || [], update, { primaryServer: edition.chat.primaryServer || '' });
    if (!result.ok) return { ok: false, errors: result.errors };

    if (result.saslPassword) {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, errors: { saslPassword: 'connection_error_encryption' } };
        const encrypted = safeStorage.encryptString(result.saslPassword).toString('hex');
        if (result.profile.serverType === 'external') result.profile.externalServer.encryptedSaslPassword = encrypted;
        else result.profile.encryptedSaslPassword = encrypted;
    }
    appStore.set('profiles', result.profiles);
    log.info(`Connection ${result.profile.hash} saved from the settings page`);
    notifyProfilesChanged(null);
    return { ok: true, profile: publicProfile(result.profile, edition.chat.networkName), profiles: connectionsList() };
});

ipcMain.handle('connections-delete', (event, hash) => {
    if (!isShellRequest(event)) return { ok: false, reason: 'forbidden' };
    if (!canDeleteConnection(appStore.get('profiles', []) || [], hash)) return { ok: false, reason: 'not_allowed' };
    // Same cleanup as closing the tab (token, password, profile store, socket)
    deleteStoredProfile(hash);
    return { ok: true, profiles: connectionsList() };
});

ipcMain.handle('connections-test', async (event, payload = {}) => {
    if (!isShellRequest(event)) return { ok: false, reason: 'forbidden' };
    const refused = connectionTestLimiter.tryStart();
    if (refused) return { ok: false, reason: refused };
    try {
        return await testServerConnection(payload);
    } finally {
        connectionTestLimiter.finish();
    }
});

// Curated servers: read from cache
/** Server list bundled with this build: the directory until the first download. */
const bundledServerList = loadBundledServerList();

function serverDirectory() {
    return directoryEntries(curatedServerStore.get('servers', []), bundledServerList, app.getLocale().slice(0, 2));
}

ipcMain.handle('get-curated-servers', () => {
    return {
        servers: serverDirectory(),
        syncedAt: curatedServerStore.get('syncedAt', null),
    };
});

/** The directory refresh at startup; older profiles wait for it to find their network domain. */
let startupDirectorySync = null;

/** Loads the edition's server list (public StarChat list by default) into the cache. */
async function syncServerDirectory() {
    const url = serverListUrl(edition);
    if (!url) return { servers: [], syncedAt: null };
    const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const servers = toDirectoryEntries(await resp.json(), app.getLocale().slice(0, 2));
    // A broken or empty answer never replaces a working directory
    if (!servers.length) throw new Error('the server list is empty or not valid');
    const syncedAt = new Date().toISOString();
    curatedServerStore.set('servers', servers);
    curatedServerStore.set('syncedAt', syncedAt);
    log.info(`Synced ${servers.length} servers of the directory`);
    return { servers, syncedAt };
}

ipcMain.handle('sync-curated-servers', async () => {
    try {
        return await syncServerDirectory();
    } catch (err) {
        log.warn('Server directory sync failed:', err.message);
        return {
            servers: serverDirectory(),
            syncedAt: curatedServerStore.get('syncedAt', null),
            error: err.message,
        };
    }
});

// Window controls act on the window that sent them (main window, manager, log viewer)
ipcMain.on('minimize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    win?.minimize();
    if (win === mainWindow) updateTaskbarOverlay();
});
ipcMain.on('maximize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win) return;
    win.isMaximized() ? win.restore() : win.maximize();
});
ipcMain.on('close-window', async () => {
    log.info('Close window requested');

    const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Cancel', 'Close'],
        defaultId: 1,
        cancelId: 0,
        title: 'Confirm Exit',
        message: `Are you sure you want to close ${APP_NAME}?`,
        detail: 'Unsaved changes or ongoing chats might be lost.',
    });

    if (result.response === 1) {
        log.info('User confirmed close.');
        mainWindow.close();
    } else {
        log.info('User canceled close.');
    }
});

// ---------------- App-Lifecycle ----------------

// Applies to every window (shell, manager, log viewer, notifications, splash):
// no in-app popups and no top-level navigation away from the bundled files.
// Links (target=_blank, window.open), also from chat iframes, open in the system browser.
app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        openExternalSafely(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (navEvent, url) => {
        if (isBundledFileUrl(url)) return;
        navEvent.preventDefault();
        openExternalSafely(url);
    });
});

app.whenReady().then(async () => {
    // Second instance: quitting already, the running one got focused
    if (!hasSingleInstanceLock) return;
    log.info('App starting...');

    // Voice chat: microphone for the bundled chat only, never the camera.
    // Every other permission keeps Electron's default (granted).
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (permission !== 'media') return callback(true);
        // The built-in chat or a downloaded (signed) chat update
        const allowed = isAllowedMediaRequest(details, BUILT_IN_CHAT_DIR) || isAllowedMediaRequest(details, CHAT_BUNDLES_DIR);
        if (!allowed) log.warn(`Media permission denied for ${details?.requestingUrl} (${(details?.mediaTypes || []).join(',')})`);
        callback(allowed);
    });

    // Home profiles belong to one primary server: bind older ones, drop those of another server
    const { kept, dropped, bound } = usableProfiles(appStore.get('profiles', []), edition.chat.primaryServer || '');
    if (dropped.length || bound) {
        appStore.set('profiles', kept);
        if (bound) log.info(`Bound ${bound} profile(s) to ${edition.chat.primaryServer}`);
        if (dropped.length) log.warn(`Removed ${dropped.length} profile(s) of another primary server than ${edition.chat.primaryServer || '(none)'}, with their credentials`);
    }

    // Cleanup orphaned profile store files
    cleanupOrphanedProfileStores();

    // Server directory older than a day: refresh it in the background
    const syncedAt = curatedServerStore.get('syncedAt', null);
    // Entries cached by an older version lack the network domain
    const cachedWithoutDomain = curatedServerStore.get('servers', []).some(server => !('domain' in server));
    if (!syncedAt || cachedWithoutDomain || (Date.now() - new Date(syncedAt).getTime()) > 24 * 60 * 60 * 1000) {
        startupDirectorySync = syncServerDirectory().catch(err => log.warn('Server directory sync at startup failed:', err.message));
    }

    registerIrcLinkHandler();
    createSplashWindow();
}).catch(err => log.error('App failed to start:', err));

app.on('window-all-closed', () => {
    if (process.env.NODE_ENV !== 'development') app.quit();
});

app.on('activate', () => {
    if (hasSingleInstanceLock && BrowserWindow.getAllWindows().length === 0) createSplashWindow();
});
