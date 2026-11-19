/**
 * Server Window Mixin
 * The classic IRC status window: numerics, server notices, service replies
 * (NickServ, ChanServ, ...) and the commands typed by the user.
 *
 * The window never takes part in the unread logic. It only shows a small
 * activity dot on its rail button when a reply arrives after an own command
 * or a service/error line comes in.
 */
export const SERVER_WINDOW = 'Server';

/** Arguments after these service commands are secrets and never echoed. */
const SECRET_SERVICE_COMMANDS = /^((?:identify|register|passwd|password|ghost|recover|regain|drop|sadrop|saregister|resetpass)\b)(.*)$/i;

/** Window in which replies after an own command light up the rail button. */
const COMMAND_REPLY_WINDOW_MS = 15000;

const SERVER_LINE_LIMIT = 1000;

/**
 * Hide passwords in an outgoing line (IDENTIFY, REGISTER, PASS, OPER, ...).
 */
export function maskSecrets(line) {
    const text = String(line || '');
    const raw = text.match(/^(PASS|OPER\s+\S+|AUTHENTICATE)\s+(.*)$/i);
    if (raw) return `${raw[1]} ********`;

    const service = text.match(/^(PRIVMSG\s+\S+\s+:?|NS\s+|NICKSERV\s+|CS\s+|CHANSERV\s+)(.*)$/i);
    if (service) {
        const secret = service[2].match(SECRET_SERVICE_COMMANDS);
        if (secret && secret[2].trim()) return `${service[1]}${secret[1]} ********`;
    }
    return text;
}

function formatDuration(seconds) {
    let rest = Math.max(0, parseInt(seconds, 10) || 0);
    const parts = [];
    for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]]) {
        if (rest >= size) {
            parts.push(`${Math.floor(rest / size)}${unit}`);
            rest %= size;
        }
    }
    parts.push(`${rest}s`);
    return parts.join(' ');
}

function formatEpoch(value) {
    const epoch = parseInt(value, 10);
    return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toLocaleString() : value;
}

/**
 * Readable texts for common WHOIS/WHOWAS/channel numerics: [translation key, replacements].
 * params[0] is always our own nick.
 */
const NUMERIC_FORMATTERS = {
    '311': (p) => [['whois_user', { nick: p[1], user: p[2], host: p[3], realname: p[5] || '' }]],
    '314': (p) => [['whowas_user', { nick: p[1], user: p[2], host: p[3], realname: p[5] || '' }]],
    '312': (p) => [['whois_server', { nick: p[1], server: p[2], info: p[3] ? `(${p[3]})` : '' }]],
    '317': (p) => [
        ['whois_idle', { nick: p[1], idle: formatDuration(p[2]) }],
        p[3] && /^\d+$/.test(p[3]) ? ['whois_signon', { signon: formatEpoch(p[3]) }] : null,
    ],
    '319': (p) => [['whois_channels', { nick: p[1], channels: p[2] || '' }]],
    '330': (p) => [['whois_account', { nick: p[1], account: p[2] }]],
    '301': (p) => [['whois_away', { nick: p[1], message: p[2] || '' }]],
    '333': (p) => [['topic_set_by', { channel: p[1], nick: p[2], date: formatEpoch(p[3]) }]],
    '329': (p) => [['channel_created', { channel: p[1], date: formatEpoch(p[2]) }]],
};

export function serverWindowMixin() {
    return {
        serverWindowActivity: false,
        _lastServerCommandAt:  0,

        isServerWindow(target = this.currentChannel) {
            return target === SERVER_WINDOW;
        },

        /**
         * Whether the target can receive chat text (channel or DM, not the server window).
         */
        isChatTarget(target = this.currentChannel) {
            return Boolean(target) && target !== SERVER_WINDOW;
        },

        openServerWindow() {
            if (this.sidebarMode !== 'channels') {
                if (this.isDirectMessageChannel(this.currentChannel)) this.lastDMBeforeChannel = this.currentChannel;
                this.sidebarMode = 'channels';
                this.selectedFriendName = '';
            }
            this.messageManager.ensure(SERVER_WINDOW);
            this.switchChannel(SERVER_WINDOW);
            this.serverWindowActivity = false;
        },

        clearServerWindow() {
            const bucket = this.stores.messages.get()[SERVER_WINDOW];
            if (bucket) bucket.content = [];
        },

        /**
         * Add a line to the server window.
         *
         * @param {string} text
         * @param {{ kind?: 'in'|'out'|'error'|'notice', from?: string }} options
         */
        addToServerWindow(text, { kind = 'in', from = '' } = {}) {
            const value = String(text ?? '').replace(/\s+$/, '');
            if (!value.trim()) return;

            this.messageManager.add(SERVER_WINDOW, {
                user: SERVER_WINDOW,
                text: value,
                from,
                serverKind: kind,
                isSystem: true,
                isAction: false,
                isJoinPart: false,
                timestamp: new Date().toLocaleTimeString(),
                _ts: Date.now(),
            });
            const bucket = this.stores.messages.get()[SERVER_WINDOW];
            if (bucket.content.length > SERVER_LINE_LIMIT) bucket.content.splice(0, bucket.content.length - SERVER_LINE_LIMIT);

            if (this.currentChannel === SERVER_WINDOW) {
                if (!this.isScrolledUp) this.scrollToBottom();
                return;
            }
            const isReply = Date.now() - this._lastServerCommandAt < COMMAND_REPLY_WINDOW_MS;
            if (kind === 'notice' || kind === 'error' || (kind === 'in' && isReply)) {
                this.serverWindowActivity = true;
            }
        },

        /**
         * Send a raw line typed by the user (/quote, /raw, /ns, text in the server
         * window, unknown slash commands) and echo it into the server window.
         */
        sendServerCommand(line) {
            const command = String(line || '').trim();
            if (!command) return false;
            this._lastServerCommandAt = Date.now();
            const sent = this.sendRaw(command);
            const shown = maskSecrets(command);
            this.addToServerWindow(sent ? shown : `${shown}  (${this.t('server_not_connected')})`, { kind: sent ? 'out' : 'error' });
            return sent;
        },

        /**
         * CTCP request (VERSION, PING, TIME, ...) to a nick or channel. A PING without text carries
         * the send time, so the reply shows the round trip.
         */
        sendCtcpRequest(target, command, text = '') {
            const name = String(command || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            const nick = String(target || '').trim();
            if (!name || !nick || /[\s\u0000-\u001F]/.test(nick)) return false;

            const payload = name === 'PING' && !text ? String(Date.now()) : String(text).replace(/[\u0000-\u001F]/g, '');
            this._lastServerCommandAt = Date.now();
            const sent = this.sendRaw(`PRIVMSG ${nick} :\u0001${name}${payload ? ` ${payload}` : ''}\u0001`);
            const shown = this.t('ctcp_sent', { command: name, nick });
            this.addToServerWindow(sent ? shown : `${shown}  (${this.t('server_not_connected')})`, { kind: sent ? 'out' : 'error' });
            return sent;
        },

        /** A CTCP reply (NOTICE) for us, shown in the server window. */
        showCtcpReply(nick, command, text) {
            let reply = text;
            if (command === 'PING' && /^\d{10,}$/.test(text)) {
                const seconds = Math.max(0, Date.now() - Number(text)) / 1000;
                reply = this.t('ctcp_ping_reply', { seconds: seconds.toFixed(2) });
            }
            this.addToServerWindow(this.t('ctcp_reply', { command, nick, text: reply }).trim(), { kind: 'notice', from: nick });
        },

        /**
         * Send a command to a service (/ns, /cs, ...).
         */
        sendServiceCommand(service, text) {
            const body = String(text || '').trim();
            if (!body) {
                this.addToServerWindow(this.t('server_command_usage', { usage: `/${service.slice(0, 2).toLowerCase()} <…>` }), { kind: 'error' });
                return;
            }
            this.sendServerCommand(`PRIVMSG ${service} :${body}`);
        },

        /**
         * Everything that originates from a server (not a user) is logged here.
         * Lines that are pure noise (NAMES/WHO of the automatic channel refresh) are skipped.
         */
        logServerLine(msg, skipped) {
            if (!msg.fromServer || msg.command === 'BATCH') return;
            if (msg.tags?.batch && this.activeBatches?.has(msg.tags.batch)) return;
            const isNumeric = /^\d{3}$/.test(msg.command);
            if (isNumeric && skipped.has(msg.command)) return;

            let display;
            if (isNumeric) {
                display = this.formatServerNumeric(msg);
            } else if (['FAIL', 'WARN', 'NOTE'].includes(msg.command)) {
                display = `${msg.command} ${msg.params.slice(0, 2).join(' ')}: ${msg.params[msg.params.length - 1] || ''}`;
            } else {
                display = msg.hasTrailing ? msg.params[msg.params.length - 1] : '';
            }
            if (!display || display === '-' || display === '*') return;

            const code = parseInt(msg.command, 10);
            const isError = msg.command === 'FAIL' || (isNumeric && code >= 400 && code < 600);
            const kind = isError ? 'error' : (msg.command === 'NOTICE' ? 'notice' : 'in');
            this.addToServerWindow(display, { kind, from: isNumeric || msg.command === 'NOTICE' ? '' : msg.command });
        },

        formatServerNumeric(msg) {
            const formatter = NUMERIC_FORMATTERS[msg.command];
            if (!formatter || msg.params.length < 3) return msg.params.slice(1).join(' ');
            return formatter(msg.params)
                .filter(Boolean)
                .map(([key, replacements]) => this.t(key, replacements).trim())
                .join('');
        },

        /**
         * Prefix shown in front of a server window line.
         */
        serverLinePrefix(message) {
            if (message.serverKind === 'out') return '→';
            if (message.serverKind === 'error') return '!';
            if (message.from) return `-${message.from}-`;
            return '*';
        },
    };
}
