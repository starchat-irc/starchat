/**
 * Turns the connection profile the desktop shell sends (init-chat-config) and the
 * edition settings from the build into mountChat() options.
 *
 * A profile is bound to one server, so the login dialog offers no server choice.
 * Profiles of type "home" use the primary server of the edition, "external" ones
 * the server stored in the profile.
 */

/** Shell messages the chat accepts from its parent frame (see src/ui/mixins/shell.js). */
export const SHELL_MESSAGE_TYPES = [
    'settings-state',
    'set-theme',
    'open-settings',
    'tab-activated',
    'set-playing',
    'open-channel',
    'app-resumed',
    'connections-response',
    'connections-changed',
    'native-socket-event',
];

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

/**
 * Domain for the discovery lookup: the network domain of the profile when the host belongs
 * to it, else the host itself. IP addresses have none (".invalid" never resolves).
 */
function domainOf(host, networkDomain = '') {
    const domain = text(networkDomain).toLowerCase();
    if (DOMAIN.test(domain) && (host === domain || host.endsWith(`.${domain}`))) return domain;
    return DOMAIN.test(host) ? host : 'ip-address.invalid';
}

/**
 * Server entry for a profile with its own server: TCP (host, port, TLS) through the app
 * or a secure WebSocket.
 */
export function externalServerEntry(profile) {
    const id = `profile-${text(profile.profileHash).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'external'}`.slice(0, 40);
    if (profile.connectionType === 'socket') {
        const host = text(profile.socketHost).toLowerCase();
        const port = Number(profile.socketPort);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
        return {
            id,
            name: text(profile.networkName) || host,
            domain: domainOf(host, profile.networkDomain),
            languages: [],
            irc: { host, port, tls: profile.socketSsl !== false },
        };
    }
    const url = text(profile.websocketUrl);
    let host = '';
    try {
        const parsed = new URL(url);
        // ws:// without TLS is allowed: the user set up this server deliberately
        if (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') host = parsed.hostname.toLowerCase();
    } catch {
        // invalid URL, handled below
    }
    if (!host) return null;
    return {
        id,
        name: text(profile.networkName) || host,
        domain: domainOf(host, profile.networkDomain),
        languages: [],
        websocket: url,
        allowInsecureWebsocket: url.startsWith('ws:'),
    };
}

/**
 * @param {Object} profile standaloneConfig from main.js
 * @param {Object} edition generated/edition.json
 * @return {{ options: Object, error: string|null }}
 */
export function mountOptionsFor(profile, edition) {
    const chat = edition.chat || {};
    const options = {
        appName: edition.appName,
        shell: 'desktop',
        serverList: false,
        theme: chat.theme || 'auto',
        overrides: {},
    };
    if (chat.ctcpVersion) options.ctcpVersion = chat.ctcpVersion;
    if (chat.defaultQuitMessage) options.defaultQuitMessage = chat.defaultQuitMessage;

    // Settings and drafts per connection profile (the keys the desktop chat always used)
    const profileHash = text(profile.profileHash);
    if (profileHash) options.storageScope = profileHash;

    const locale = text(profile.locale);
    if (locale) options.locale = locale;
    const language = (locale || 'en').slice(0, 2);
    options.overrides = { ...(edition.texts?.en || {}), ...(edition.texts?.[language] || {}) };

    if (profile.isExternalServer) {
        const server = externalServerEntry(profile);
        if (!server) return { options, error: 'invalid-server' };
        options.primaryServer = server;
        const channel = text(profile.defaultChannel);
        if (channel) options.defaultChannel = channel;
    } else {
        if (!chat.primaryServer) return { options, error: 'no-primary-server' };
        options.primaryServer = chat.primaryServer;
        if (chat.defaultChannel) options.defaultChannel = chat.defaultChannel;
    }

    const nickname = text(profile.nickname);
    const token = text(profile.password);
    if (profile.authMethod === 'sasl_plain' && nickname && profile.saslPassword) {
        options.nickname = nickname;
        options.password = String(profile.saslPassword);
        const account = text(profile.saslUsername);
        if (account && account !== nickname) options.saslAccount = account;
    } else if (token) {
        // A token stored for this profile ("remember me"); main drops it when the server changes
        options.bearer = async () => ({ token, nickname: nickname || undefined });
    } else if (profile.isExternalServer && nickname) {
        options.nickname = nickname;
    }
    return { options, error: null };
}
