/**
 * Connection profiles: shared by the profile manager and the "+" quick dialog of the
 * main window, so both create and validate connections the same way.
 *
 * Plain script (no build step): exposes window.ConnectionForm in the renderer and
 * module.exports for the unit tests.
 */
(function (root) {
    'use strict';

    const DEFAULT_PORT = 6697;
    /** RFC 2812 nick: letter or special first, then letters, digits, specials or "-". */
    const NICK_PATTERN = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/;
    /** Host name or IPv4/IPv6 literal: no scheme, path or whitespace. */
    const HOST_PATTERN = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

    function uuid() {
        if (root.crypto?.randomUUID) return root.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function emptyExternalServer() {
        return {
            connectionType: 'socket',
            websocketUrl: '',
            host: '',
            port: DEFAULT_PORT,
            ssl: true,
            nickname: '',
            authMethod: 'none',
            saslUsername: '',
            saslPassword: '',
            defaultChannel: '',
            domain: '',
        };
    }

    /** Host the profile connects to: the IRC host or the host of the WebSocket URL. */
    function serverHost(server) {
        if (server?.connectionType === 'websocket') {
            try { return new URL(String(server.websocketUrl || '')).hostname.toLowerCase(); } catch { return ''; }
        }
        return String(server?.host || '').trim().toLowerCase();
    }

    /**
     * Domain of the network for its discovery file (login, API, features). Only the host
     * itself or a parent domain of it, never a foreign one: the API there receives the
     * login of this connection.
     */
    function networkDomain(server) {
        const domain = String(server?.domain || '').trim().toLowerCase();
        const host = serverHost(server);
        if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain) || !host) return '';
        return host === domain || host.endsWith(`.${domain}`) ? domain : '';
    }

    /** Connection fields of a server from the curated directory. */
    function fromCuratedServer(server) {
        return {
            ...emptyExternalServer(),
            connectionType: server?.host ? 'socket' : 'websocket',
            websocketUrl: server?.websocket_url || '',
            host: server?.host || '',
            port: Number(server?.port || DEFAULT_PORT),
            ssl: server?.ssl !== false,
            defaultChannel: server?.default_channel || '',
            domain: server?.domain || '',
        };
    }

    /**
     * Validate an external server. Returns { field: translationKey }: empty when valid.
     *
     * @param {object} ext
     * @param {{ requireNickname?: boolean, hasSaslPassword?: boolean, saslPassword?: string }} options
     */
    function validateExternalServer(ext, options = {}) {
        const errors = {};
        const server = ext || {};

        if (server.connectionType === 'websocket') {
            let url = null;
            try { url = new URL(String(server.websocketUrl || '').trim()); } catch { /* invalid */ }
            if (!url || !['wss:', 'ws:'].includes(url.protocol)) errors.websocketUrl = 'connection_error_websocket_url';
        } else {
            const host = String(server.host || '').trim();
            if (!host) errors.host = 'connection_error_host_required';
            else if (!HOST_PATTERN.test(host)) errors.host = 'connection_error_host_invalid';

            const port = Number(server.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'connection_error_port';
        }

        const nick = String(server.nickname || '').trim();
        if (nick && !NICK_PATTERN.test(nick)) errors.nickname = 'connection_error_nickname';
        if (!nick && options.requireNickname) errors.nickname = 'connection_error_nickname_required';

        const channel = String(server.defaultChannel || '').trim();
        if (channel && !/^[#&][^\s,\x07]{1,49}$/.test(channel)) errors.defaultChannel = 'connection_error_channel';

        const hasPassword = Boolean(options.saslPassword) || Boolean(options.hasSaslPassword);
        if (String(server.saslUsername || '').trim() && !hasPassword) errors.saslPassword = 'connection_error_sasl_password';

        return errors;
    }

    /** Validate a home profile (primary server of the edition): only the optional SASL login can be wrong. */
    function validateHomeProfile(profile, options = {}) {
        const errors = {};
        const nick = String(profile?.nickname || '').trim();
        if (nick && !NICK_PATTERN.test(nick)) errors.nickname = 'connection_error_nickname';
        const hasPassword = Boolean(options.saslPassword) || Boolean(options.hasSaslPassword);
        if (String(profile?.saslUsername || '').trim() && !hasPassword) errors.saslPassword = 'connection_error_sasl_password';
        return errors;
    }

    /** Cleaned copy of an external server, ready to be stored. */
    function normalizeExternalServer(ext, { saslPassword = '', hasSaslPassword = false } = {}) {
        const server = { ...emptyExternalServer(), ...(ext || {}) };
        server.websocketUrl = String(server.websocketUrl || '').trim();
        server.host = String(server.host || '').trim();
        server.port = Number(server.port) || DEFAULT_PORT;
        server.ssl = server.ssl !== false;
        server.nickname = String(server.nickname || '').trim();
        server.saslUsername = String(server.saslUsername || '').trim();
        server.saslPassword = ''; // never stored in plain text: encrypted via IPC
        server.defaultChannel = String(server.defaultChannel || '').trim();
        server.domain = networkDomain(server);
        server.authMethod = server.saslUsername && (saslPassword || hasSaslPassword) ? 'sasl_plain' : 'none';
        return server;
    }

    function buildHomeProfile(overrides = {}) {
        return { hash: uuid(), name: null, loggingEnabled: false, showServerWindow: false, serverType: 'home', ...overrides };
    }

    function buildExternalProfile({ name = '', externalServer = {}, saslPassword = '' } = {}) {
        const server = normalizeExternalServer(externalServer, { saslPassword });
        return {
            hash: uuid(),
            name: String(name || '').trim() || server.nickname || 'External',
            loggingEnabled: false,
            showServerWindow: false,
            serverType: 'external',
            externalServer: server,
        };
    }

    /** "irc.libera.chat:6697 (TLS)" or the WebSocket URL: for lists and summaries. */
    function describeServer(ext) {
        if (!ext) return '';
        if (ext.connectionType === 'websocket') return ext.websocketUrl || '';
        return ext.host ? `${ext.host}:${ext.port || DEFAULT_PORT}${ext.ssl !== false ? ' (TLS)' : ''}` : '';
    }

    /** Name of the edition's primary server in tab labels, set by the shell at start. */
    let homeNetworkName = 'Home';

    function setHomeNetworkName(name) {
        if (typeof name === 'string' && name.trim()) homeNetworkName = name.trim();
    }

    /** Identity of the server a profile talks to: equal keys mean the same network. */
    function serverKey(profile) {
        if (profile?.serverType !== 'external') return 'home';
        const ext = profile.externalServer || {};
        const address = ext.connectionType === 'websocket' ? ext.websocketUrl : ext.host;
        return `external:${String(address || profile.hash || '').toLowerCase()}`;
    }

    /** Short network name: the profile name, else the host without a leading "irc.". */
    function networkName(profile) {
        if (profile?.serverType !== 'external') return homeNetworkName;
        const ext = profile.externalServer || {};
        const name = String(profile.name || '').trim();
        if (name && name !== 'External' && name.toLowerCase() !== String(ext.nickname || '').toLowerCase()) return name;
        let host = ext.host || '';
        if (!host && ext.websocketUrl) {
            try { host = new URL(ext.websocketUrl).hostname; } catch { host = ''; }
        }
        return host.replace(/^irc\./i, '') || name || 'IRC';
    }

    /**
     * Tab label: the nick, plus the network ("Obi_Wan · Libera") as soon as tabs to
     * more than one network are open.
     *
     * @param {object} profile
     * @param {number} index
     * @param {object[]} profiles all open profiles
     * @return {string}
     */
    function tabLabel(profile, index, profiles = []) {
        const nick = profile?.serverType === 'external'
            ? (profile.externalServer?.nickname || '')
            : (profile?.name || '');
        const networks = new Set(profiles.map(serverKey));
        if (networks.size <= 1) return nick || networkName(profile) || `Connection ${index + 1}`;
        return nick ? `${nick} · ${networkName(profile)}` : networkName(profile);
    }

    function defaultServerIcon() {
        return "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2232%22 height=%2232%22><rect width=%2232%22 height=%2232%22 fill=%22%23343a40%22 rx=%226%22/><text x=%2216%22 y=%2221%22 text-anchor=%22middle%22 fill=%22%23868e96%22 font-size=%2212%22 font-family=%22sans-serif%22>IRC</text></svg>";
    }

    const api = {
        DEFAULT_PORT,
        emptyExternalServer,
        fromCuratedServer,
        networkDomain,
        validateExternalServer,
        validateHomeProfile,
        normalizeExternalServer,
        buildHomeProfile,
        buildExternalProfile,
        describeServer,
        serverKey,
        networkName,
        setHomeNetworkName,
        tabLabel,
        defaultServerIcon,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ConnectionForm = api;
})(typeof window !== 'undefined' ? window : globalThis);
