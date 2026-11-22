/**
 * Boot of the shell inside the Capacitor WebView: native plugins, profiles, the start
 * screen, the connections drawer and the chat iframe. The logic lives in controller.mjs
 * and profiles.mjs.
 */
import './shell.css';
import { createTranslator } from '../../src/i18n/index.js';
import edition from '../generated/edition.json';
import bundledServers from '../generated/servers.json';
import iconUrl from '../generated/icon.png';
import de from '../locales/de.json';
import en from '../locales/en.json';
import ConnectionForm from '../../desktop/html/shared/connection.js';
import { createShell } from './controller.mjs';
import { createProfileStore } from './profiles.mjs';

const SHELL_TEXTS = { de, en };

function translator() {
    const locale = navigator.languages?.length ? [...navigator.languages] : [navigator.language || 'en'];
    const language = String(locale[0] || 'en').slice(0, 2) in SHELL_TEXTS ? String(locale[0]).slice(0, 2) : 'en';
    const overrides = { ...en, ...SHELL_TEXTS[language], ...(edition.texts?.en || {}), ...(edition.texts?.[language] || {}) };
    return { t: createTranslator({ locale, overrides, appName: edition.appName }), language, locale: locale[0] || 'en' };
}

const $ = (id) => document.getElementById(id);

function button(label, detail, onClick, className = '') {
    const element = document.createElement('button');
    element.type = 'button';
    if (className) element.className = className;
    const title = document.createElement('span');
    title.textContent = label;
    element.append(title);
    if (detail) {
        const small = document.createElement('small');
        small.textContent = detail;
        element.append(small);
    }
    element.addEventListener('click', onClick);
    return element;
}

/** DOM side of the shell for controller.mjs. */
function createUi({ t, onPickConnection }) {
    const drawer = $('drawer');
    const backdrop = $('drawerBackdrop');

    function setDrawer(open) {
        drawer.classList.toggle('open', open);
        drawer.setAttribute('aria-hidden', String(!open));
        backdrop.hidden = !open;
    }
    backdrop.addEventListener('click', () => setDrawer(false));

    return {
        showChat(hash, onLoad) {
            document.body.classList.remove('chat-ready', 'welcome');
            $('welcome').hidden = true;
            const frame = document.createElement('iframe');
            frame.title = edition.appName;
            frame.allow = 'clipboard-read; clipboard-write; autoplay; fullscreen; microphone';
            frame.dataset.profile = hash;
            frame.addEventListener('load', onLoad, { once: true });
            frame.src = 'chat/index.html';
            $('chatHost').replaceChildren(frame);
            return frame;
        },
        showWelcome() {
            $('chatHost').replaceChildren();
            document.body.classList.add('welcome');
            $('welcome').hidden = false;
        },
        setReady(ready) {
            document.body.classList.toggle('chat-ready', ready);
        },
        renderConnections(entries) {
            $('connectionList').replaceChildren(...entries.map(entry => button(
                entry.label,
                entry.active ? t('connections_current') : '',
                () => onPickConnection(entry.hash),
                entry.active ? 'active' : '',
            )));
        },
        openDrawer: () => setDrawer(true),
        closeDrawer: () => setDrawer(false),
        isDrawerOpen: () => drawer.classList.contains('open'),
    };
}

/** Start screen: nickname, then a network from the directory or an own server. */
function setUpWelcome({ t, profiles, onCreated }) {
    $('welcomeTitle').textContent = t('shell_welcome_title');
    $('welcomeIntro').textContent = t('shell_welcome_intro');
    $('nicknameLabel').textContent = t('connections_field_nickname');
    $('networksTitle').textContent = t('shell_welcome_networks');
    $('networksRetry').textContent = t('shell_welcome_retry');
    $('customTitle').textContent = t('shell_welcome_custom');
    $('hostLabel').textContent = t('connections_field_host');
    $('portLabel').textContent = t('connections_field_port');
    $('tlsLabel').textContent = t('connections_field_tls');
    $('customConnect').textContent = t('shell_welcome_connect');

    const showErrors = (errors) => {
        const message = Object.values(errors || {}).map(key => t(key)).join(' ');
        $('welcomeError').textContent = message;
        $('welcomeError').hidden = !message;
    };

    const nickname = () => {
        const value = $('nickname').value.trim();
        if (!value) {
            showErrors({ nickname: 'shell_welcome_nickname_first' });
            $('nickname').focus();
            return null;
        }
        return value;
    };

    async function finish(result) {
        if (!result.ok) {
            showErrors(result.errors);
            return;
        }
        showErrors(null);
        await onCreated(result.profile.hash);
    }

    function renderNetworks(servers, state = '') {
        $('networks').replaceChildren(...servers.map(server => button(
            server.name,
            server.description || ConnectionForm.describeServer(ConnectionForm.fromCuratedServer(server)),
            async () => {
                const nick = nickname();
                if (nick) await finish(await profiles.addFromDirectory(server, nick));
            },
        )));
        $('networksState').textContent = state;
        $('networksState').hidden = !state;
        $('networksRetry').hidden = state !== t('shell_welcome_no_servers');
    }

    async function loadNetworks() {
        const servers = profiles.directory();
        if (servers.length) {
            renderNetworks(servers);
            return;
        }
        renderNetworks([], t('shell_welcome_loading'));
        const result = await profiles.syncDirectory();
        renderNetworks(result.servers || [], result.servers?.length ? '' : t('shell_welcome_no_servers'));
    }

    $('networksRetry').addEventListener('click', loadNetworks);
    $('customConnect').addEventListener('click', async () => {
        const nick = nickname();
        if (!nick) return;
        await finish(await profiles.addCustom({
            connectionType: 'socket',
            host: $('host').value.trim(),
            port: Number($('port').value),
            ssl: $('tls').checked,
            nickname: nick,
        }));
    });
    loadNetworks();
}

async function start() {
    const plugins = window.Capacitor?.Plugins || {};
    const plugin = plugins.StarChatShell;
    const app = plugins.App;
    const { t, language, locale } = translator();
    document.title = edition.appName;
    document.documentElement.lang = language;
    $('drawerIcon').src = iconUrl;
    $('drawerTitle').textContent = t('shell_connections');
    $('manageConnections').textContent = t('shell_manage_connections');

    const profiles = createProfileStore({
        store: {
            get: async key => (await plugin.getStore({ key }))?.value ?? null,
            set: async (key, value) => { await plugin.setStore({ key, value }); },
        },
        secrets: {
            encrypt: async value => (await plugin.encrypt({ value })).value,
            decrypt: async value => (await plugin.decrypt({ value })).value,
        },
        edition,
        bundledServers,
        language,
        testConnection: payload => (payload.connectionType === 'websocket'
            ? Promise.resolve({ ok: false, reason: 'unknown' })
            : plugin.testConnection({ host: String(payload.host || ''), port: Number(payload.port), ssl: payload.ssl !== false })),
    });
    await profiles.load();

    const lightQuery = window.matchMedia('(prefers-color-scheme: light)');
    let shell = null;
    const ui = createUi({ t, onPickConnection: hash => shell.open(hash) });
    shell = createShell({
        plugin,
        app,
        profiles,
        ui,
        locale,
        theme: () => (edition.chat.theme === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : null),
    });
    $('manageConnections').addEventListener('click', () => shell.manageConnections());

    setUpWelcome({ t, profiles, onCreated: hash => shell.open(hash, { reload: true }) });

    window.addEventListener('message', event => shell.handleMessage(event));
    lightQuery.addEventListener('change', () => shell.sendTheme());
    app.addListener('backButton', () => shell.handleBackButton());
    app.addListener('resume', () => shell.handleResume());
    app.addListener('pause', () => shell.handlePause());
    plugin.addListener('socket', event => shell.handleSocketEvent(event));
    plugin.addListener('pushOpened', event => shell.openTarget(event));
    plugin.addListener('shareReceived', () => shell.shareReceived());

    await shell.start();
    await shell.openTarget(await plugin.takePendingTarget().catch(() => null));
    await shell.shareReceived();
    profiles.refreshDirectoryIfOld().catch(() => {});
}

if (window.Capacitor) {
    start().catch(error => console.error('[shell]', error));
}
