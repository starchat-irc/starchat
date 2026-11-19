/**
 * Push module (IRCv3 draft/webpush)
 * Registers this device with the IRC server so direct messages and mentions arrive while
 * the chat is closed. Needs a logged-in account and a server that offers the capability
 * and its VAPID key (ISUPPORT VAPID).
 *  - Browser: service worker (pushWorker option, a copy of push-sw.js on the page's origin)
 *    and the browser's push service. Works on any network with draft/webpush, no API needed.
 *  - App (shell 'mobile'): the app hands over its FCM token and keys (receivePushSubscription),
 *    the network's API relays to FCM (feature "push", see docs/discovery.md).
 *  - Desktop: no push service, the app stays connected in the tray instead.
 */
import { SCOPE } from '../ui/settings/registry.js';

const APP_REPLY_TIMEOUT_MS = 15000;

export function base64UrlToBytes(value) {
    const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether an existing subscription was made for this VAPID key (the server may change it). */
export function sameKey(buffer, vapidKey) {
    return Boolean(buffer) && bytesToBase64Url(buffer) === String(vapidKey).replace(/=+$/, '');
}

/** Endpoint and keys go into one IRC line: no spaces, endpoint only https. */
export function webpushRegisterLine({ endpoint, p256dh, auth }) {
    const valid = (value) => typeof value === 'string' && /^[A-Za-z0-9_\-=]+$/.test(value);
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || /\s/.test(endpoint)) return null;
    if (!valid(p256dh) || !valid(auth)) return null;
    return `WEBPUSH REGISTER ${endpoint} p256dh=${p256dh};auth=${auth}`;
}

export function pushMixin() {
    return {
        supportsWebpush: false,
        webpushVapidKey: null,
        /** { endpoint, platform, fcmToken? } of the active registration, null when none. */
        _pushRegistration: null,
        _pushRegistering: false,
        _pendingPushTarget: null,
        /** Waiting for the app's answer to "push-subscribe". */
        _pushAppReply: null,
        /** Last registration problem ('denied' or a message), shown in the settings. */
        pushError: null,
        _pushAnnounced: false,

        /** 'browser', 'app' or null when this device cannot receive push. */
        pushPlatform() {
            if (this.shell === 'mobile') return 'app';
            if (this.shell) return null;
            if (!this.pushWorker || !globalThis.navigator?.serviceWorker || !globalThis.PushManager) return null;
            return 'browser';
        },

        /** The server sends push to accounts, a guest nick has nothing to register. */
        hasPushAccount() {
            return Boolean(this.loginMechanism?.());
        },

        canUsePush() {
            const platform = this.pushPlatform();
            if (!platform || !this.supportsWebpush || !this.webpushVapidKey || !this.hasPushAccount()) return false;
            // The app needs the network's relay to FCM
            return platform === 'browser' || (this.hasFeature('push') && this.hasApiToken);
        },

        /** ISUPPORT VAPID=<key>: the server's application server key. Sent on every connect. */
        applyVapidKey(value) {
            const key = String(value || '').trim();
            if (!key) return;
            this.webpushVapidKey = key;
            this.registerWebPush();
        },

        /** Runs on every connect, the server expects registrations to be refreshed. */
        async registerWebPush() {
            if (!this.canUsePush() || this._pushRegistering) return;
            this._pushRegistering = true;
            try {
                const platform = this.pushPlatform();
                const subscription = platform === 'app'
                    ? await this.subscribeAppPush()
                    : await this.subscribeBrowserPush();
                if (!subscription || !this.canSendChat()) return;
                const line = webpushRegisterLine(subscription);
                if (!line) throw new Error('invalid subscription');

                this.sendRaw(line);
                this._pushRegistration = { endpoint: subscription.endpoint, platform, fcmToken: subscription.fcmToken || null };
                this.pushError = null;
                this.syncPushFilter();
                if (!this._pushAnnounced) {
                    this._pushAnnounced = true;
                    this.addToServerWindow?.(this.t('push_registered'));
                }
            } catch (error) {
                const message = String(error?.message || error);
                this.pushError = /denied/i.test(message) ? 'denied' : message;
                console.warn('[push] registration failed:', error);
                this.addToServerWindow?.(this.t('push_failed', { error: message }));
            } finally {
                this._pushRegistering = false;
            }
        },

        async subscribeBrowserPush() {
            if (globalThis.Notification?.permission !== 'granted') return null;

            const registration = await navigator.serviceWorker.register(this.pushWorker);
            await navigator.serviceWorker.ready;
            let subscription = await registration.pushManager.getSubscription();
            if (subscription && !sameKey(subscription.options?.applicationServerKey, this.webpushVapidKey)) {
                await subscription.unsubscribe();
                subscription = null;
            }
            subscription ??= await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToBytes(this.webpushVapidKey),
            });

            const { endpoint, keys } = subscription.toJSON();
            return { endpoint, p256dh: keys?.p256dh, auth: keys?.auth };
        },

        /** Asks the app for its FCM token and keys, then the API for the relay endpoint. */
        async subscribeAppPush() {
            const device = await this.askAppForPush();
            if (!device?.fcmToken) return null;

            const response = await this.connection.api('chat/push-devices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fcm_token: device.fcmToken }),
            });
            if (!response.ok) throw new Error(`device registration failed (${response.status})`);
            const { endpoint } = await response.json();

            return { endpoint, p256dh: device.p256dh, auth: device.auth, fcmToken: device.fcmToken };
        },

        askAppForPush() {
            this._pushAppReply?.reject(new Error('push-subscribe: replaced'));
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this._pushAppReply = null;
                    reject(new Error('push-subscribe: no answer from the app'));
                }, APP_REPLY_TIMEOUT_MS);
                this._pushAppReply = {
                    resolve: (value) => { clearTimeout(timer); resolve(value); },
                    reject: (error) => { clearTimeout(timer); reject(error); },
                };
                this.notifyHost('push-subscribe');
            });
        },

        /** The app's answer to "push-subscribe": { fcmToken, p256dh, auth } or { error }. */
        receivePushSubscription(data) {
            const reply = this._pushAppReply;
            if (!reply) return;
            this._pushAppReply = null;
            if (data?.error) reply.reject(new Error(String(data.error)));
            else reply.resolve(data || null);
        },

        /** What the settings show about push on this device (translation key or { key, replacements }). */
        pushStatus() {
            const platform = this.pushPlatform();
            if (platform === null) return 'push_status_unsupported_device';
            if (!this.hasPushAccount()) return 'push_status_account_only';
            if (!this.supportsWebpush || !this.webpushVapidKey) return 'push_status_unsupported_server';
            if (platform === 'app' && !(this.hasFeature('push') && this.hasApiToken)) return 'push_status_unsupported_server';
            if (this._pushRegistration) return 'push_status_active';
            if (this.pushError === 'denied' || (platform === 'browser' && globalThis.Notification?.permission === 'denied')) {
                return platform === 'app' ? 'push_status_denied_app' : 'push_status_denied_browser';
            }
            if (this.pushError) return { key: 'push_status_error', replacements: { error: this.pushError } };
            return 'push_status_inactive';
        },

        /** Button of the push setting, only when trying again can help. */
        pushActionLabel() {
            if (this._pushRegistration || !this.canUsePush() || this._pushRegistering) return '';
            if (this.pushPlatform() === 'browser' && globalThis.Notification?.permission === 'denied') return '';
            return 'push_enable';
        },

        async enablePush() {
            if (this.pushPlatform() === 'browser' && globalThis.Notification?.permission === 'default') {
                await Notification.requestPermission();
            }
            this.pushError = null;
            await this.registerWebPush();
            // permission is not reactive: nudge Alpine to read the status again
            if (this.settingsWindow) this.settingsWindow = { ...this.settingsWindow };
        },

        /** Muted channels and ignored users: the device drops their pushes (the server cannot read them). */
        pushFilter() {
            return {
                muted: Object.entries(this.channelNotifications || {})
                    .filter(([, level]) => level === 'mute')
                    .map(([channel]) => channel.toLowerCase()),
                ignored: (this.ignoredUsers || []).map((nick) => nick.toLowerCase()),
            };
        },

        syncPushFilter() {
            const registration = this._pushRegistration;
            if (!registration) return;
            const filter = this.pushFilter();
            if (registration.platform === 'app') {
                this.notifyHost('push-filter', filter);
                return;
            }
            globalThis.navigator?.serviceWorker?.getRegistration(this.pushWorker)
                .then((worker) => worker?.active?.postMessage({ type: 'push-filter', ...filter }))
                .catch(() => {});
        },

        /** Logout: stop pushes for this device. Runs while the socket and the token are still there. */
        unregisterWebPush() {
            const registration = this._pushRegistration;
            this._pushRegistration = null;
            this._pushAnnounced = false;
            if (!registration) return;

            if (this.canSendChat()) this.sendRaw(`WEBPUSH UNREGISTER ${registration.endpoint}`);

            if (registration.platform === 'browser') {
                globalThis.navigator?.serviceWorker?.getRegistration(this.pushWorker)
                    .then((worker) => worker?.pushManager.getSubscription())
                    .then((subscription) => subscription?.unsubscribe())
                    .catch(() => {});
            }
            if (registration.platform === 'app') {
                this.connection.api('chat/push-devices', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fcm_token: registration.fcmToken }),
                }).catch(() => {});
                this.notifyHost('push-unsubscribe');
            }
        },

        /**
         * A tapped notification (service worker or app) opens its conversation.
         * Before the first joins are through (cold start) it waits for finishBulkJoin().
         */
        openPushTarget(target) {
            if (!target || typeof target !== 'string') return;
            // A tapped call notification of the app (calls module)
            if (target.startsWith('call:')) {
                this.openCallFromPush?.(target.slice(5));
                return;
            }
            if (!this.isRegistered || this._bulkJoining > 0) {
                this._pendingPushTarget = target;
                return;
            }
            this._pendingPushTarget = null;
            this._pendingActiveChannel = null;
            if (/^[#&]/.test(target)) {
                const joined = this.availableChannels.find((channel) => channel.toLowerCase() === target.toLowerCase());
                if (!joined) return;
                this.sidebarMode = 'channels';
                this.switchChannel(joined);
                return;
            }
            this.sendPrivateMessage(target);
        },

        applyPendingPushTarget() {
            const target = this._pendingPushTarget;
            if (!target) return false;
            this._pendingPushTarget = null;
            this.openPushTarget(target);
            return true;
        },
    };
}

export function registerPushSettings(registry) {
    registry.registerSetting({
        id: 'notifications.push',
        section: 'notifications',
        type: 'action',
        scope: SCOPE.Device,
        order: 25,
        when: env => env.shell !== 'desktop',
        label: 'settings_push',
        hint: 'settings_push_hint',
        keywords: ['push', 'benachrichtigung', 'notification', 'handy', 'offline'],
        status: chat => chat.pushStatus(),
        actionLabel: 'push_enable',
        actionLabelFor: chat => chat.pushActionLabel(),
        run: chat => chat.enablePush(),
    });
}

/** @type {import('./index.js').ChatModule} */
export const pushModule = {
    name: 'push',
    mixin: pushMixin,
    register: registerPushSettings,
    hooks: {
        init() {
            // Opened from a notification while the chat was closed (push-sw.js adds ?open=)
            try {
                this._pendingPushTarget = new URL(globalThis.location?.href).searchParams.get('open') || null;
            } catch {
                this._pendingPushTarget = null;
            }
            globalThis.navigator?.serviceWorker?.addEventListener?.('message', (event) => {
                if (event.data?.type === 'open-target') this.openPushTarget(event.data.target);
            });
        },
        loggingOut() {
            this.unregisterWebPush();
        },
    },
};
