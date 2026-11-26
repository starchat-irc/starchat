import { isServiceNick } from './services.js';

/**
 * Slash commands. Each handler gets the arguments split at spaces and the chat
 * context, which provides the actions (sendRaw, joinChannel, t, ...). Editions add
 * their own commands with registerCommand().
 */

/**
 * /scene <channel> <text> or /npc <channel> <name> <text>. Without a channel the
 * current one is used.
 */
function sendRoleplayLine(ctx, command, args, withName) {
    const rest = [...args];
    const channel = rest[0]?.startsWith('#') ? rest.shift() : ctx.currentChannel;
    const name = withName ? rest.shift() : null;
    const text = rest.join(' ').trim();
    if (!channel?.startsWith('#') || (withName && !name) || !text) {
        ctx.updateStatus(`Usage: /${command.toLowerCase()} [#channel] ${withName ? '<name> ' : ''}<text>`);
        return;
    }
    ctx.sendRaw(`${command} ${channel} ${name ? `${name} ` : ''}:${text}`);
}

/** Chat commands need a channel or DM, not the server window. */
function requireChatTarget(ctx) {
    if (ctx.isChatTarget()) return true;
    ctx.addToServerWindow(ctx.t('server_chat_only'), { kind: 'error' });
    return false;
}

const commands = {
    join: (args, ctx) => {
        const channels = (args[0] || '').split(',').map((ch) => ch.trim().toLowerCase()).filter(Boolean);
        channels.forEach((channel) => {
            // No switch to the channel here: the window opens on the server's JOIN,
            // with the casing the server uses
            ctx.joinChannel(channel.startsWith('#') ? channel : `#${channel}`);
        });
    },
    part: (args, ctx) => {
        ctx.partChannel(args);
    },
    msg: (args, ctx) => {
        let recipient = args[0];
        const text = args.slice(1).join(' ');
        if (!recipient || !text) return;
        // Reuse an existing DM window with the same name (case-insensitive)
        if (!recipient.startsWith('#')) {
            const existing = ctx.messageManager.keys().find(
                (k) => !k.startsWith('#') && k.toLowerCase() === recipient.toLowerCase()
            );
            if (existing) recipient = existing;
        }
        // Messages to services go to the server window, not into a DM
        if (isServiceNick(recipient) && !ctx.hasOpenQuery(recipient)) {
            ctx.sendServiceCommand(recipient, text);
            return;
        }
        ctx.sendOwnMessage(recipient, text);
        ctx.switchChannel(recipient);
    },
    nick: (args, ctx) => {
        if (!args[0]) return;
        ctx.sendRaw(`NICK ${args[0]}`);
    },
    /** /displayname <name> sets the display name, without a name it is removed. */
    displayname: (args, ctx) => {
        if (!ctx.supportsMetadata) {
            ctx.updateStatus(ctx.t('display_name_unsupported'));
            return;
        }
        const name = ctx.changeOwnDisplayName(args.join(' '));
        ctx.updateStatus(name ? `${ctx.t('display_name_set')} ${name}` : ctx.t('display_name_cleared'));
    },
    me: (args, ctx) => {
        if (!requireChatTarget(ctx)) return;
        ctx.sendOwnMessage(ctx.currentChannel, args.join(' '), { isAction: true });
        ctx.scrollToBottom();
    },
    ignore: (args, ctx) => {
        const user = args[0];
        if (!user) {
            ctx.updateStatus(ctx.ignoredUsers.length ? `Ignored: ${ctx.ignoredUsers.join(', ')}` : 'Nobody is ignored.');
            return;
        }
        if (ctx.ignoreUser(user)) ctx.updateStatus(`${user} is now ignored.`);
    },
    unignore: (args, ctx) => {
        const user = args[0];
        if (ctx.unignoreUser(user)) ctx.updateStatus(`${user} is no longer ignored.`);
    },
    /**
     * /highlight                  list the highlight words
     * /highlight add <word>[, ...] add words (comma separated, spaces allowed)
     * /highlight del <word>       remove a word
     * /highlight clear            remove all words
     */
    highlight: (args, ctx) => {
        const action = (args[0] || '').toLowerCase();
        const value = args.slice(1).join(' ').trim();

        if (action === 'add' && value) {
            ctx.addHighlightWords(value);
        } else if ((action === 'del' || action === 'remove') && value) {
            ctx.removeHighlightWord(value);
        } else if (action === 'clear') {
            ctx.setHighlightWords([]);
        } else if (action) {
            ctx.updateStatus(ctx.t('highlight_usage'));
            return;
        }

        ctx.updateStatus(ctx.highlightWords.length
            ? ctx.t('highlight_list', { words: ctx.highlightWords.join(', ') })
            : ctx.t('highlight_empty'));
    },
    list: (args, ctx) => {
        ctx.requestChannelList();
    },
    whois: (args, ctx) => {
        const user = args[0];
        if (!user) return;
        // Asking the user's own server returns idle time and sign-on as well
        ctx.sendServerCommand(`WHOIS ${user} ${user}`);
    },
    quote: (args, ctx) => {
        ctx.sendServerCommand(args.join(' '));
    },
    raw: (args, ctx) => {
        ctx.sendServerCommand(args.join(' '));
    },
    /** /ctcp <nick> <command> [text], e.g. /ctcp alice VERSION. The reply shows in the server window. */
    ctcp: (args, ctx) => {
        const [target, command, ...rest] = args;
        if (!target || !command) {
            ctx.addToServerWindow(ctx.t('server_command_usage', { usage: '/ctcp <nick> <VERSION|PING|TIME|...>' }), { kind: 'error' });
            return;
        }
        ctx.sendCtcpRequest(target, command, rest.join(' '));
    },
    /** /version: the IRC server's version. /version <nick>: CTCP VERSION of that user. */
    version: (args, ctx) => {
        if (!args[0]) {
            ctx.sendServerCommand('VERSION');
            return;
        }
        ctx.sendCtcpRequest(args[0], 'VERSION');
    },
    ns: (args, ctx) => ctx.sendServiceCommand('NickServ', args.join(' ')),
    cs: (args, ctx) => ctx.sendServiceCommand('ChanServ', args.join(' ')),
    hs: (args, ctx) => ctx.sendServiceCommand('HostServ', args.join(' ')),
    ms: (args, ctx) => ctx.sendServiceCommand('MemoServ', args.join(' ')),
    os: (args, ctx) => ctx.sendServiceCommand('OperServ', args.join(' ')),
    // Roleplay (Ergo): narration and lines of non-player characters in a channel.
    // UMGEBUNG is the narration command of ST-City's Ergo, SCENE the standard one.
    scene: (args, ctx) => sendRoleplayLine(ctx, 'SCENE', args, false),
    umgebung: (args, ctx) => sendRoleplayLine(ctx, 'UMGEBUNG', args, false),
    npc: (args, ctx) => sendRoleplayLine(ctx, 'NPC', args, true),
    npca: (args, ctx) => sendRoleplayLine(ctx, 'NPCA', args, true),
    server: (args, ctx) => {
        ctx.openServerWindow();
    },
    away: (args, ctx) => {
        const message = args.join(' ') || 'Away';
        ctx.sendRaw(`AWAY :${message}`);
        ctx.activeUsers.setAway(ctx.nickname, true);
        ctx.updateStatus(`You are now marked as away: ${message}`);
    },
    back: (args, ctx) => {
        ctx.sendRaw('AWAY');
        ctx.activeUsers.setAway(ctx.nickname, false);
        ctx.updateStatus('You are no longer marked as away.');
    },
    roll: (args, ctx) => {
        if (!requireChatTarget(ctx)) return;
        const result = Math.floor(Math.random() * 20) + 1;
        ctx.sendOwnMessage(ctx.currentChannel, `${ctx.nickname} rolls a d20: ${result}`, { isAction: true });
    },
    flip: (args, ctx) => {
        if (!requireChatTarget(ctx)) return;
        const result = Math.random() > 0.5 ? 'Heads' : 'Tails';
        ctx.sendOwnMessage(ctx.currentChannel, `${ctx.nickname} flips a coin: ${result}`, { isAction: true });
    },
};

/**
 * Add or replace a command. Names are lower case without the slash.
 *
 * @param {string} name
 * @param {(args: string[], ctx: Object) => void} handler
 */
export function registerCommand(name, handler) {
    commands[name.toLowerCase()] = handler;
}

export { commands };
export default commands;
