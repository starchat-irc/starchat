/**
 * Chat page of the desktop app. The shell (html/index.html) loads it once per connection
 * profile in an iframe and sends the profile with `init-chat-config`. Everything between
 * chat and shell goes through postMessage to the parent frame; messages from anywhere
 * else are ignored.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import '../../src/ui/theme.css';
import '../generated/edition-theme.css';
import { defaultModules, mountChat, nativeSocketConnector } from '../../src/index.js';
import edition from '../generated/edition.json';
import { mountOptionsFor, SHELL_MESSAGE_TYPES } from './profile-options.mjs';

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

/** Resolves with the profile the shell sends after the page loaded. */
function waitForProfile() {
    return new Promise((resolve) => {
        window.addEventListener('message', function onConfig(event) {
            if (event.source !== parent || event.data?.type !== 'init-chat-config') return;
            window.removeEventListener('message', onConfig);
            resolve(event.data.config || {});
        });
    });
}

/** Shell messages for the chat, only from the parent frame and only known types. */
function shellMessages(listener) {
    window.addEventListener('message', (event) => {
        if (event.source !== parent) return;
        const { type, ...data } = event.data || {};
        if (SHELL_MESSAGE_TYPES.includes(type)) listener(type, data);
    });
}

/** TCP sockets are opened by the main process; the shell passes lines and events through. */
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

/**
 * Voice settings of the desktop chat before StarChat (key chat.voice): taken over once, so
 * microphone and push to talk stay as they were after the switch.
 */
function takeOverVoiceSettings() {
    try {
        const old = localStorage.getItem('chat.voice');
        if (old !== null && localStorage.getItem('starchat.voice') === null) localStorage.setItem('starchat.voice', old);
    } catch {
        // storage unavailable: defaults
    }
}

async function start() {
    if (parent === window) {
        showError('This page runs inside the desktop app only.');
        return;
    }
    const profile = await waitForProfile();
    takeOverVoiceSettings();
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
        modules,
        onHostMessage: toShell,
        shellMessages,
        nativeSocket,
    });
    // The shell shows its window and hands over the now-playing state
    toShell('chat-app-ready');
}

start().catch((error) => {
    console.error(error);
    toShell('renderer-error', { error: { message: String(error?.message || error), stack: String(error?.stack || '') } });
    showError(`The chat could not be started: ${error.message}`);
});
