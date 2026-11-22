/**
 * The shell of the mobile app (counterpart of desktop/html/index.html and the IPC handlers
 * in desktop/main.js). It runs one chat page at a time, for the connection on screen, and
 * answers its postMessage requests with the native plugin: sockets, credentials, push,
 * links. Switching the connection replaces the chat page; the sockets of the old one are
 * closed, push keeps notifying for all connections.
 *
 * DOM work is left to `ui` (see main.mjs), so this part runs in tests.
 */

const EXTERNAL_URL = /^(https?:|mailto:)/i;

/**
 * @param {Object} options
 * @param {Object} options.plugin StarChatShell plugin
 * @param {Object} options.app Capacitor App plugin
 * @param {ReturnType<import('./profiles.mjs').createProfileStore>} options.profiles
 * @param {Object} options.ui see main.mjs
 * @param {string} [options.locale]
 * @param {() => 'dark'|'light'|null} [options.theme] theme the chat should follow, null to leave it
 */
export function createShell({ plugin, app, profiles, ui, locale = '', theme = () => null }) {
    let frame = null;
    let frameHash = '';
    let chatReady = false;
    /** Native sockets of the chat page on screen: closed when it goes. */
    const openSockets = new Set();
    /** Notification target waiting for its chat: { profile, target }. */
    let pendingTarget = null;
    let shareWaiting = false;

    const post = (message) => frame?.contentWindow?.postMessage(message, '*');

    function sendTheme() {
        const current = theme();
        if (current) post({ type: 'set-theme', theme: current });
    }

    function closeSockets() {
        for (const connectionId of openSockets) plugin.socketClose({ connectionId }).catch(() => {});
        openSockets.clear();
    }

    function renderConnections() {
        ui.renderConnections(profiles.profiles.map(profile => ({
            hash: profile.hash,
            label: profiles.label(profile.hash),
            active: profile.hash === profiles.active,
        })));
    }

    /** Shows the chat of a connection; the page of another one is replaced. */
    async function open(hash, { reload = false } = {}) {
        ui.closeDrawer();
        if (!reload && frame && frameHash === hash) return;
        if (!(await profiles.setActive(hash))) return;
        closeSockets();
        chatReady = false;
        frameHash = hash;
        const config = await profiles.configFor(hash, locale);
        const shown = ui.showChat(hash, () => {
            if (frame !== shown) return;
            post({ type: 'init-chat-config', config });
            sendTheme();
        });
        frame = shown;
        renderConnections();
    }

    /** Start: the remembered connection, or the start screen when there is none. */
    async function start() {
        if (!profiles.profiles.length) {
            frame = null;
            frameHash = '';
            ui.showWelcome();
            renderConnections();
            return;
        }
        await open(profiles.active || profiles.profiles[0].hash, { reload: true });
    }

    async function connectionsRequest({ id, action, payload }) {
        const result = await profiles.request(action, payload, frameHash);
        const { open: openHash, deleted, ...answer } = result;
        post({ type: 'connections-response', id, result: answer });
        if (deleted) {
            plugin.pushUnsubscribe({ profile: deleted }).catch(() => {});
            if (deleted === frameHash) await open(profiles.active, { reload: true });
        }
        if (action === 'save' || deleted) {
            post({ type: 'connections-changed' });
            renderConnections();
        }
        if (openHash) await open(openHash);
    }

    function socketRequest(type, data = {}) {
        const connectionId = String(data.connectionId || '');
        if (type === 'native-socket-connect') {
            openSockets.add(connectionId);
            plugin.socketConnect({ connectionId, host: data.host, port: Number(data.port), ssl: data.ssl !== false }).catch((error) => {
                post({ type: 'native-socket-event', connectionId, event: 'error', error: String(error?.message || error) });
                post({ type: 'native-socket-event', connectionId, event: 'close' });
            });
        } else if (type === 'native-socket-send') {
            // The quit message is only for desktop apps that close sockets themselves
            if (typeof data.line === 'string') plugin.socketSend({ connectionId, line: data.line }).catch(() => {});
        } else if (type === 'native-socket-close') {
            openSockets.delete(connectionId);
            plugin.socketClose({ connectionId }).catch(() => {});
        }
    }

    /** Socket events of the plugin, only for the sockets of the chat on screen. */
    function handleSocketEvent(event) {
        if (!openSockets.has(event?.connectionId)) return;
        if (event.event === 'close') openSockets.delete(event.connectionId);
        post({ type: 'native-socket-event', connectionId: event.connectionId, event: event.event, data: event.data, error: event.error });
    }

    async function deliverPending() {
        if (!chatReady) return;
        if (pendingTarget && (!pendingTarget.profile || pendingTarget.profile === frameHash)) {
            post({ type: 'open-target', target: pendingTarget.target });
            pendingTarget = null;
        }
        if (shareWaiting) {
            shareWaiting = false;
            const share = await plugin.takePendingShare().catch(() => null);
            if (share && (share.text || share.subject || share.file || share.tooLarge || share.unreadable)) post({ type: 'share-received', share });
        }
    }

    /** A tapped notification: its connection comes on screen, then the conversation. */
    async function openTarget(result) {
        if (!result?.target) return;
        const profile = typeof result.profile === 'string' ? result.profile : '';
        pendingTarget = { profile, target: result.target };
        if (profile && profile !== frameHash && profiles.profiles.some(entry => entry.hash === profile)) {
            await open(profile);
            return;
        }
        if (!profile || profile === frameHash) pendingTarget.profile = '';
        await deliverPending();
    }

    async function handleMessage(event) {
        if (!frame || event.source !== frame.contentWindow) return;
        const data = event.data;
        if (!data || typeof data.type !== 'string') return;
        const hash = frameHash;

        switch (data.type) {
            case 'chat-app-ready':
                chatReady = true;
                ui.setReady(true);
                await deliverPending();
                break;
            case 'native-socket-connect':
            case 'native-socket-send':
            case 'native-socket-close':
                socketRequest(data.type, data.data);
                break;
            case 'connections-request':
                await connectionsRequest(data);
                break;
            case 'show-connections':
                renderConnections();
                ui.openDrawer();
                break;
            case 'save-credentials':
                // On a phone a login always stays: "remember me" is a desktop choice
                if (typeof data.token === 'string' && data.token) await profiles.setToken(hash, data.token);
                else if (typeof data.saslPassword === 'string') await profiles.setSaslLogin(hash, data.saslAccount, data.saslPassword);
                break;
            case 'logout':
                await profiles.clearLogin(hash);
                break;
            case 'update-profile-name':
                await profiles.setNickname(hash, data.nickname);
                renderConnections();
                break;
            case 'push-subscribe':
                try {
                    const device = await plugin.pushSubscribe({ profile: hash, name: profiles.label(hash) });
                    post({ type: 'push-subscription', fcmToken: device.fcmToken, p256dh: device.p256dh, auth: device.auth });
                } catch (error) {
                    post({ type: 'push-subscription', error: error?.message || String(error) });
                }
                break;
            case 'push-filter':
                await plugin.setPushFilter({
                    profile: hash,
                    muted: Array.isArray(data.muted) ? data.muted : [],
                    ignored: Array.isArray(data.ignored) ? data.ignored : [],
                }).catch(() => {});
                break;
            case 'push-unsubscribe':
                await plugin.pushUnsubscribe({ profile: hash }).catch(() => {});
                break;
            case 'settings-get':
                post({ type: 'settings-state', app: { connectionsApi: true }, connection: {} });
                break;
            case 'settings-action':
                if (data.action === 'open-notification-settings') await plugin.openNotificationSettings().catch(() => {});
                break;
            case 'open-external':
                if (typeof data.url === 'string' && EXTERNAL_URL.test(data.url)) await plugin.openExternal({ url: data.url }).catch(() => {});
                break;
            case 'get-app-version': {
                const info = await app.getInfo().catch(() => null);
                post({ type: 'app-version', version: info?.version || '' });
                break;
            }
            case 'back-button-result':
                if (!data.handled) await app.minimizeApp().catch(() => {});
                break;
            case 'renderer-error':
                console.error('[chat]', data.error);
                break;
            default:
        }
    }

    /** Android back: drawer first, then the chat (dialogs, drawers), then to the background. */
    function handleBackButton() {
        if (ui.isDrawerOpen()) {
            ui.closeDrawer();
            return;
        }
        if (frame) {
            post({ type: 'back-button' });
            return;
        }
        app.minimizeApp().catch(() => {});
    }

    return {
        start,
        open,
        handleMessage,
        handleSocketEvent,
        handleBackButton,
        openTarget,
        sendTheme,
        renderConnections,
        handleResume: () => post({ type: 'app-resumed' }),
        handlePause: () => post({ type: 'app-paused' }),
        /** Shared from another app: the chat on screen gets it once it is ready. */
        async shareReceived() {
            shareWaiting = true;
            await deliverPending();
        },
        /** The connections page of the chat settings. */
        manageConnections() {
            ui.closeDrawer();
            post({ type: 'open-settings', section: 'connections' });
        },
        get activeHash() {
            return frameHash;
        },
    };
}
