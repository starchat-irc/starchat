/**
 * Message Actions Mixin
 * IRCv3 reactions (+draft/react / +draft/unreact), replies (+draft/reply) and
 * deleting own messages (draft/message-redaction), plus matching the echo of
 * own messages (echo-message) so they get their msgid.
 *
 * None of these events count as unread.
 */
import { escapeTagValue } from '../../core/irc-parser.js';
import { stripFormatting } from '../../core/formatting.js';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

/** A reaction value longer than this is not an emoji and is ignored. */
const MAX_REACTION_LENGTH = 32;
const ORPHAN_LIMIT = 2000;
const PENDING_ECHO_LIMIT = 200;
const PENDING_ECHO_TTL_MS = 10 * 60 * 1000;
const REDACT_CONFIRM_TIMEOUT_MS = 4000;
const DELETE_CONFIRM_WINDOW_MS = 4000;

function sameNick(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function messageActionsMixin() {
    return {
        replyingTo:     null, // { target, msgid, user, text }
        reactionPicker: { show: false, x: 0, y: 0, target: null, msgid: null },
        clientTagDeny:  { all: false, denied: [], allowed: [] },
        pendingDeleteId: null, // message id whose delete button waits for the second click
        _pendingDeleteTimer: null,
        _pendingEchoes:     [],
        _orphanAnnotations: new Map(), // "target|msgid" -> [{ type, ... }]

        // Capabilities

        /**
         * Client-only tag usable on this server? (message-tags + ISUPPORT CLIENTTAGDENY)
         */
        canUseClientTag(name) {
            if (!this.supportsMessageTags) return false;
            const deny = this.clientTagDeny;
            if (deny.all) return deny.allowed.includes(name);
            return !deny.denied.includes(name);
        },

        /**
         * ISUPPORT CLIENTTAGDENY=*,-draft/react or CLIENTTAGDENY=typing,draft/reply
         */
        applyClientTagDeny(value) {
            const deny = { all: false, denied: [], allowed: [] };
            String(value || '').split(',').filter(Boolean).forEach((entry) => {
                if (entry === '*') deny.all = true;
                else if (entry.startsWith('-')) deny.allowed.push(entry.slice(1));
                else deny.denied.push(entry);
            });
            this.clientTagDeny = deny;
        },

        canReact()  { return this.canUseClientTag('draft/react') && this.canUseClientTag('draft/reply'); },
        canReply()  { return this.canUseClientTag('draft/reply'); },
        canRedact() { return Boolean(this.supportsRedaction); },

        isOwnMessage(message) {
            return sameNick(message?.user, this.nickname);
        },

        /**
         * Only real chat lines with a server msgid can be reacted to, replied to or deleted.
         */
        isActionableMessage(message) {
            return Boolean(message?.msgid) && !message.redacted && !message.isSystem && !message.isJoinPart
                && this.isChatTarget(this.currentChannel);
        },

        canReactTo(message)  { return this.canReact() && this.isActionableMessage(message); },
        canReplyTo(message)  { return this.canReply() && this.isActionableMessage(message); },
        canDelete(message)   { return this.canRedact() && this.isActionableMessage(message) && this.isOwnMessage(message) && !message.deleting; },
        hasMessageActions(message) {
            return this.canReactTo(message) || this.canReplyTo(message) || this.canDelete(message)
                || Boolean(this.canReportMessage?.(message));
        },

        // Lookup / annotations

        findMessageByMsgid(target, msgid) {
            if (!target || !msgid) return null;
            const messages = this.messageManager.get(target);
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].msgid === msgid) return messages[i];
            }
            return null;
        },

        /**
         * Apply an annotation (reaction/redaction) now, or keep it until the message
         * shows up (history batch still buffering, older page not loaded yet).
         */
        annotateMessage(target, msgid, annotation) {
            const message = this.findMessageByMsgid(target, msgid);
            if (message) {
                this.applyAnnotation(message, annotation);
                return;
            }
            const key = `${target}|${msgid}`;
            const list = this._orphanAnnotations.get(key) || [];
            list.push(annotation);
            this._orphanAnnotations.set(key, list);
            if (this._orphanAnnotations.size > ORPHAN_LIMIT) {
                this._orphanAnnotations.delete(this._orphanAnnotations.keys().next().value);
            }
        },

        /**
         * Messages just added to a target: apply annotations that arrived before them.
         */
        applyOrphanAnnotations(target, messages) {
            if (this._orphanAnnotations.size === 0) return;
            for (const message of messages) {
                if (!message?.msgid) continue;
                const key = `${target}|${message.msgid}`;
                const list = this._orphanAnnotations.get(key);
                if (!list) continue;
                this._orphanAnnotations.delete(key);
                list.forEach(annotation => this.applyAnnotation(message, annotation));
            }
        },

        applyAnnotation(message, annotation) {
            if (annotation.type === 'redact') {
                this.markRedacted(message);
            } else if (annotation.type === 'react') {
                this.applyReaction(message, annotation.emoji, annotation.nick, annotation.add);
            }
        },

        // Reactions

        applyReaction(message, emoji, nick, add) {
            if (message.redacted) return;
            const reactions = Array.isArray(message.reactions) ? message.reactions : [];
            let entry = reactions.find(reaction => reaction.emoji === emoji);
            if (add) {
                if (!entry) {
                    entry = { emoji, nicks: [] };
                    reactions.push(entry);
                }
                if (!entry.nicks.some(existing => sameNick(existing, nick))) entry.nicks.push(nick);
            } else if (entry) {
                entry.nicks = entry.nicks.filter(existing => !sameNick(existing, nick));
            }
            message.reactions = reactions.filter(reaction => reaction.nicks.length > 0);
        },

        hasReacted(reaction) {
            return reaction.nicks.some(nick => sameNick(nick, this.nickname));
        },

        reactionTitle(reaction) {
            return `${reaction.nicks.join(', ')} – ${reaction.emoji}`;
        },

        /**
         * React with an emoji, or take the own reaction back.
         */
        toggleReaction(message, emoji) {
            if (!this.canReactTo(message) || !emoji) return;
            const target = this.currentChannel;
            const existing = (message.reactions || []).find(reaction => reaction.emoji === emoji);
            const add = !(existing && this.hasReacted(existing));
            const tag = add ? '+draft/react' : '+draft/unreact';
            const sent = this.sendRaw(`@+draft/reply=${escapeTagValue(message.msgid)};${tag}=${escapeTagValue(emoji)} TAGMSG ${target}`);
            if (sent) this.applyReaction(message, emoji, this.nickname, add);
        },

        /**
         * TAGMSG carrying +draft/react / +draft/unreact (live or from history).
         *
         * @return {boolean} true when the TAGMSG was a reaction
         */
        handleReactionTag(msg, target) {
            const react = msg.tags['+draft/react'] ?? msg.tags['+react'];
            const unreact = msg.tags['+draft/unreact'];
            const emoji = react ?? unreact;
            const msgid = msg.tags['+draft/reply'] ?? msg.tags['+reply'];
            if (emoji === undefined) return false;
            if (!emoji || !msgid || emoji.length > MAX_REACTION_LENGTH || !msg.nick) return true;
            if (this.ignoredUsers.some(ignored => sameNick(ignored, msg.nick))) return true;

            this.annotateMessage(target, msgid, { type: 'react', emoji, nick: msg.nick, add: react !== undefined });
            return true;
        },

        openReactionPicker(message, event) {
            if (!this.canReactTo(message)) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const width = 320;
            const height = 360;
            this.reactionPicker = {
                show: true,
                x: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
                y: rect.top - height - 6 > 8 ? rect.top - height - 6 : Math.min(rect.bottom + 6, window.innerHeight - height - 8),
                target: this.currentChannel,
                msgid: message.msgid,
            };
        },

        closeReactionPicker() {
            this.reactionPicker = { show: false, x: 0, y: 0, target: null, msgid: null };
        },

        reactFromPicker(emoji) {
            const { target, msgid } = this.reactionPicker;
            const message = target === this.currentChannel ? this.findMessageByMsgid(target, msgid) : null;
            if (message) this.toggleReaction(message, emoji);
            this.closeReactionPicker();
        },

        // Replies

        startReply(message) {
            if (!this.canReplyTo(message)) return;
            this.replyingTo = {
                target: this.currentChannel,
                msgid: message.msgid,
                user: message.user,
                text: this.messageSnippet(message),
            };
            this.$nextTick(() => this.$refs.messageInput?.focus());
        },

        cancelReply() {
            this.replyingTo = null;
        },

        /**
         * The reply the next message in the current window refers to (if any).
         */
        activeReplyTag() {
            const reply = this.replyingTo;
            if (!reply || reply.target !== this.currentChannel || !this.canReply()) return null;
            return { '+draft/reply': reply.msgid };
        },

        messageSnippet(message, length = 120) {
            if (!message) return '';
            const text = stripFormatting(message.text || '').replace(/\s+/g, ' ').trim();
            return text.length > length ? `${text.slice(0, length)}…` : text;
        },

        /**
         * Quote line above a reply: the referenced message, or null when it is not loaded.
         */
        replyPreview(message) {
            if (!message?.replyTo) return null;
            const original = this.findMessageByMsgid(this.currentChannel, message.replyTo);
            if (!original) return { user: '', text: this.t('reply_unknown'), found: false };
            if (original.redacted) return { user: original.user, text: this.t('message_deleted'), found: true };
            return { user: original.user, text: this.messageSnippet(original, 80), found: true };
        },

        jumpToMessage(msgid) {
            const chatWindow = this.$refs.chatMessages || document.querySelector('.chat-messages');
            const element = chatWindow?.querySelector(`[data-msgid="${CSS.escape(msgid)}"]`);
            if (!element) return;
            element.scrollIntoView({ block: 'center', behavior: 'smooth' });
            element.classList.add('msg--highlight');
            setTimeout(() => element.classList.remove('msg--highlight'), 1600);
        },

        // Deleting (draft/message-redaction)

        /**
         * First click arms the button ("Delete?"), a second click within a few seconds
         * deletes; Shift-click deletes right away. No confirm(): it is blocked in the
         * sandboxed iframe of the desktop app.
         */
        deleteMessage(message, event = null) {
            if (!this.canDelete(message)) return;
            if (!event?.shiftKey && this.pendingDeleteId !== message.id) {
                this.pendingDeleteId = message.id;
                clearTimeout(this._pendingDeleteTimer);
                this._pendingDeleteTimer = setTimeout(() => {
                    if (this.pendingDeleteId === message.id) this.pendingDeleteId = null;
                }, DELETE_CONFIRM_WINDOW_MS);
                return;
            }
            clearTimeout(this._pendingDeleteTimer);
            this.pendingDeleteId = null;

            const target = this.currentChannel;
            if (!this.sendRaw(`REDACT ${target} ${message.msgid}`)) return;
            message.deleting = true;

            // Without echo-message the server may not send the REDACT back; no FAIL means success.
            setTimeout(() => {
                if (message.deleting && !message.redacted) this.markRedacted(message);
            }, REDACT_CONFIRM_TIMEOUT_MS);
        },

        markRedacted(message) {
            message.redacted = true;
            message.deleting = false;
            message.text = '';
            message.reactions = [];
            if (this.replyingTo?.msgid === message.msgid) this.replyingTo = null;
        },

        /**
         * REDACT <target> <msgid> [:reason]
         */
        handleRedact(msg) {
            const [rawTarget, msgid] = msg.params;
            if (!rawTarget || !msgid) return;
            const target = this.resolveTargetKey(sameNick(rawTarget, this.nickname) ? msg.nick : rawTarget);
            this.annotateMessage(target, msgid, { type: 'redact' });
        },

        /**
         * FAIL REDACT <code> <target> <msgid> :<description>
         */
        handleRedactFailure(msg) {
            const target = this.resolveTargetKey(msg.params[2] || '');
            const message = this.findMessageByMsgid(target, msg.params[3]);
            if (message) message.deleting = false;
            this.updateStatus(msg.params[msg.params.length - 1] || this.t('delete_message_failed'));
        },

        // echo-message

        /**
         * Remember the wire texts an own message will come back with.
         */
        expectEcho(target, texts, message, isAction = false) {
            const now = Date.now();
            this._pendingEchoes = this._pendingEchoes.filter(entry => now - entry.at < PENDING_ECHO_TTL_MS);
            texts.forEach(text => this._pendingEchoes.push({ target, text, isAction, message, at: now }));
            if (this._pendingEchoes.length > PENDING_ECHO_LIMIT) {
                this._pendingEchoes.splice(0, this._pendingEchoes.length - PENDING_ECHO_LIMIT);
            }
        },

        /**
         * Echo of an own message: give the local copy its msgid instead of adding it twice.
         *
         * @return {boolean} true when the echo belonged to a locally shown message
         */
        consumeEcho(target, text, isAction, tags) {
            const index = this._pendingEchoes.findIndex(entry =>
                entry.target === target && entry.text === text && entry.isAction === isAction);
            if (index === -1) return false;

            const [entry] = this._pendingEchoes.splice(index, 1);
            const stored = this.messageManager.get(target).find(message => message.id === entry.message.id) || entry.message;
            if (!stored.msgid && tags.msgid) {
                stored.msgid = tags.msgid;
                this.ensureSeenMessageBucket(target).add(this.getMessageDedupKey(target, '', '', false, tags));
                this.applyOrphanAnnotations(target, [stored]);
            }
            stored.pending = false;
            return true;
        },
    };
}
