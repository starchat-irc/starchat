/**
 * Chat page of the mobile app. The shell (shell/index.html) loads it in an iframe for the
 * connection on screen and sends the profile with `init-chat-config`. Everything between
 * chat and shell goes through postMessage to the parent frame, like in the desktop app.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import '../../src/ui/theme.css';
import '../generated/edition-theme.css';
import { defaultModules, mountChat, nativeSocketConnector } from '../../src/index.js';
import { mountOptionsFor, SHELL_MESSAGE_TYPES } from '../../desktop/chat/profile-options.mjs';
import edition from '../generated/edition.json';

/** Messages only the mobile shell sends (see src/ui/mixins/shell.js). */
export const MOBILE_MESSAGE_TYPES = [
    ...SHELL_MESSAGE_TYPES,
    'back-button',
    'app-paused',
    'push-subscription',
    'open-target',
    'share-received',
];

const parent = window.parent;

function toShell(type, data = {}) {
    parent.postMessage({ ...data, type }, '*');
}

function showError(message) {
    const box = document.createElement('div');
    box.className = 'page-error';
    box.textContent = message;
    document.getElementById('chat').replaceChildren(box);
}

function waitForProfile() {
    return new Promise((resolve) => {
        window.addEventListener('message', function onConfig(event) {
            if (event.source !== parent || event.data?.type !== 'init-chat-config') return;
            window.removeEventListener('message', onConfig);
            resolve(event.data.config || {});
        });
    });
}

function shellMessages(listener) {
    window.addEventListener('message', (event) => {
        if (event.source !== parent) return;
        const { type, ...data } = event.data || {};
        if (MOBILE_MESSAGE_TYPES.includes(type)) listener(type, data);
    });
}

const nativeSocket = nativeSocketConnector({
    send: (type, data) => toShell(type, { data }),
    listen(listener) {
        const onEvent = (event) => {
            if (event.source === parent && event.data?.type === 'native-socket-event') listener(event.data);
        };
        window.addEventListener('message', onEvent);
        return () => window.removeEventListener('message', onEvent);
    },
});

async function start() {
    if (parent === window) {
        showError('This page runs inside the app only.');
        return;
    }
    const profile = await waitForProfile();
    const { options, error } = mountOptionsFor(profile, edition);
    if (error) {
        showError(`The connection cannot be opened (${error}).`);
        return;
    }
    const modules = edition.chat?.modules
        ? defaultModules.filter(module => edition.chat.modules.includes(module.name))
        : defaultModules;

    await mountChat('#chat', {
        ...options,
        shell: 'mobile',
        modules,
        pushGateway: edition.pushGateway || null,
        onHostMessage: toShell,
        shellMessages,
        nativeSocket,
    });
    toShell('chat-app-ready');
}

start().catch((error) => {
    console.error(error);
    toShell('renderer-error', { error: { message: String(error?.message || error), stack: String(error?.stack || '') } });
    showError(`The chat could not be started: ${error.message}`);
});
