/**
 * UI Mixin
 * Message formatting, media players, scroll behaviour, notifications and the
 * unread state for the host app.
 */
import DOMPurify from 'dompurify';
import linkifyHtml from 'linkify-html';
import { decorateText, formatClock, mircToHtml, nickHue } from '../../core/formatting.js';
import { NOTIFICATION_SOUND_MIN_INTERVAL_MS, playNotificationSound, playsOwnSound } from '../notification-sound.js';

const IMAGE_URL = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;
const MEDIA_URL = /\.(mp4|webm|mp3)(\?.*)?$/i;
const YOUTUBE_URL = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([-\w]+)/;

/** Distance from the bottom that still counts as "at the bottom" (rounding, sub-pixel scrolling). */
const STICK_TO_BOTTOM_TOLERANCE_PX = 24;

/** Senders of scene narration: Ergo's SCENE and ST-City's UMGEBUNG. */
const NARRATION_SENDERS = new Set(['=scene=', 'umgebung', '=umgebung=']);

/** Prefix of the tag of desktop notifications. A push service worker uses the same tag to replace them. */
export const NOTIFICATION_TAG_PREFIX = 'starchat:';

export function notificationTag(target) {
    return `${NOTIFICATION_TAG_PREFIX}${String(target || '').toLowerCase()}`;
}

/**
 * Metadata values are free text set by other users. Avatars are only loaded from the
 * API origin of the connection: fetching anything else would reveal the IP address of
 * every viewer to whoever hosts that URL.
 *
 * @param {string} url
 * @param {string|null} apiBaseUrl
 * @return {boolean}
 */
export function isTrustedAvatarUrl(url, apiBaseUrl) {
    if (typeof url !== 'string' || !url || !apiBaseUrl) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.origin === new URL(apiBaseUrl).origin;
    } catch {
        return false;
    }
}

/** Rendered HTML per message object (raw, non-reactive), invalidated when the own nick changes. */
const renderCache = new WeakMap();

function mediaLabel(url) {
    try {
        return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
    } catch {
        return url;
    }
}

export function uiMixin() {
    return {
        // Nick colours: the user's own choice or a hue from a hash. Lightness comes from the theme.

        nickHueOf(nick) {
            return this.customNickHue?.(nick) ?? nickHue(nick);
        },

        getNickColor(nick) {
            return `hsl(${this.nickHueOf(nick)} 70% 65%)`;
        },

        nickStyle(nick) {
            return `--nick-hue: ${this.nickHueOf(nick)}`;
        },

        nickInitial(nick) {
            return (String(nick || '?').replace(/^[^A-Za-z0-9]+/, '')[0] || '?').toUpperCase();
        },

        // Avatars, keyed by lowercased nick, so they also work for users who left the channel

        avatarUrl(nick) {
            return this.avatarUrls[String(nick || '').toLowerCase()] || '';
        },

        setUserAvatar(nick, url) {
            if (this.hasFeature('profiles') && isTrustedAvatarUrl(url, this.connection?.apiBaseUrl)) {
                this.avatarUrls[nick.toLowerCase()] = url;
            } else {
                this.clearUserAvatar(nick);
            }
        },

        clearUserAvatar(nick) {
            delete this.avatarUrls[String(nick || '').toLowerCase()];
        },

        renameUserAvatar(oldNick, newNick) {
            const url = this.avatarUrl(oldNick);
            this.clearUserAvatar(oldNick);
            if (url) this.setUserAvatar(newNick, url);
        },

        formatClock(ts) {
            return ts ? formatClock(ts, this.t('locale')) : '';
        },

        formatFullTimestamp(ts) {
            return ts ? new Date(ts).toLocaleString(this.t('locale')) : '';
        },

        // mIRC / message formatting

        parseMircFormatting(text) {
            return mircToHtml(text, this.mircColors);
        },

        /**
         * Message text to safe HTML: mIRC codes, media embeds, links, then mentions and
         * emotes in plain text nodes only (never inside links).
         */
        formatChatMessage(text) {
            let html = mircToHtml(text, this.mircColors).replace(/\r\n|\r|\n/g, '<br>');

            html = html.replace(/https?:\/\/[^\s<]+/g, (match) => {
                const url = match.replace(/&amp;/g, '&');
                const safeUrl = match; // already HTML-escaped
                if (this.isUploadUrl?.(url) || IMAGE_URL.test(url)) {
                    return `<span class="media-wrapper"><a href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img class="chat-media" src="${safeUrl}" alt="image" loading="lazy"></a></span>`;
                }
                if (MEDIA_URL.test(url)) {
                    const type = /\.mp3(\?.*)?$/i.test(url) ? 'audio' : 'video';
                    return `<span class="media-wrapper"><a href="${safeUrl}" class="media-play-card" data-media-type="${type}" target="_blank" rel="noopener noreferrer"><i class="bi bi-play-circle-fill"></i><span>${mediaLabel(url).replace(/[<>"&]/g, '')}</span></a></span>`;
                }
                const ytMatch = url.match(YOUTUBE_URL);
                if (ytMatch) {
                    const id = ytMatch[1];
                    return `<span class="media-wrapper"><a href="https://www.youtube.com/watch?v=${id}" class="youtube-card" data-youtube-id="${id}" target="_blank" rel="noopener noreferrer"><img class="chat-media youtube-thumbnail" src="https://img.youtube.com/vi/${id}/mqdefault.jpg" alt="YouTube" loading="lazy"><i class="bi bi-play-btn-fill youtube-play-icon"></i></a></span>`;
                }
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
            });

            html = linkifyHtml(html, { target: '_blank', rel: 'noopener noreferrer' });
            html = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
            return this.decorateTextNodes(html);
        },

        decorateTextNodes(html) {
            const template = document.createElement('template');
            template.innerHTML = html;
            const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            while (walker.nextNode()) {
                if (!walker.currentNode.parentElement?.closest('a')) textNodes.push(walker.currentNode);
            }
            const options = { nick: this.nickname, emotes: this.emoteMap, highlightWords: this.highlightWords || [] };
            for (const node of textNodes) {
                const decorated = decorateText(node.nodeValue, options);
                if (decorated === node.nodeValue) continue;
                const fragment = document.createElement('template');
                fragment.innerHTML = decorated;
                node.replaceWith(fragment.content);
            }
            return template.innerHTML;
        },

        /**
         * Cached formatChatMessage for a message object.
         */
        renderMessageHtml(message) {
            const raw = this.rawOf(message);
            const cached = renderCache.get(raw);
            const words = (this.highlightWords || []).join('\n');
            if (cached && cached.nick === this.nickname && cached.words === words && cached.text === raw.text) return cached.html;
            const html = this.formatChatMessage(raw.text || '');
            renderCache.set(raw, { nick: this.nickname, words, text: raw.text, html });
            return html;
        },

        messageKind(message) {
            if (!message) return null;
            if (NARRATION_SENDERS.has(String(message.user || '').toLowerCase())) return 'umgebung';
            if (message.isJoinPart) return 'joinpart';
            if (message.user === 'System' || message.user === 'Server') return 'system';
            if (message.isAction) return 'action';
            return 'text';
        },

        systemIcon(message) {
            return {
                join: 'bi-arrow-right-short text-success',
                part: 'bi-arrow-left-short text-danger',
                kick: 'bi-door-open text-danger',
                nick: 'bi-pencil',
            }[message.joinPartType] || 'bi-info-circle';
        },

        hasMediaInMessage(text) {
            if (!text || typeof text !== 'string') return false;
            return (text.match(/https?:\/\/[^\s]+/g) || []).some(url =>
                this.isUploadUrl?.(url) || IMAGE_URL.test(url) || MEDIA_URL.test(url) || YOUTUBE_URL.test(url)
            );
        },

        // Scroll

        scrollToBottom() {
            this.$nextTick(() => {
                requestAnimationFrame(() => {
                    const chatWindow = this.$refs.chatMessages || document.querySelector('.chat-messages');
                    if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
                });
            });
        },

        jumpToLatest() {
            this.scrollToBottom();
            this.isScrolledUp = false;
            this.newWhileScrolledUp = 0;
        },

        handleChatScroll(event) {
            const el = event.target;
            this.isScrolledUp = (el.scrollHeight - el.scrollTop - el.clientHeight) > 150;
            if (!this.isScrolledUp) this.newWhileScrolledUp = 0;

            if (!this.currentChannel || !this.supportsChathistory) return;
            if (el.scrollTop < 80) this.requestHistoryBefore(this.currentChannel);
        },

        /**
         * Writes the message HTML only when it changed. x-html rewrites innerHTML on
         * every re-evaluation (and the rows are rebuilt with each new message),
         * which replaced a playing video with its card again.
         */
        renderMessageInto(el, message) {
            const html = this.renderMessageHtml(message);
            if (el._renderedMessageHtml === html) return;
            el._renderedMessageHtml = html;
            el.innerHTML = html;
        },

        /**
         * Keeps the chat pinned to the bottom while content changes its height:
         * reactions, loaded images, opened players, deleted messages, a growing
         * input area. Only when the view was at the bottom before the change, so
         * reading older messages is never disturbed. Runs before paint: no jump.
         */
        setupStickToBottom() {
            const chatWindow = document.querySelector('.chat-messages');
            if (!chatWindow || chatWindow._stickToBottomBound) return;
            chatWindow._stickToBottomBound = true;

            let lastScrollHeight = chatWindow.scrollHeight;
            let lastClientHeight = chatWindow.clientHeight;

            const keepPinned = () => {
                const wasAtBottom = lastScrollHeight - chatWindow.scrollTop - lastClientHeight <= STICK_TO_BOTTOM_TOLERANCE_PX;
                lastScrollHeight = chatWindow.scrollHeight;
                lastClientHeight = chatWindow.clientHeight;
                if (wasAtBottom) {
                    chatWindow.scrollTop = chatWindow.scrollHeight;
                    lastScrollHeight = chatWindow.scrollHeight;
                }
            };

            const resizeObserver = new ResizeObserver(keepPinned);
            resizeObserver.observe(chatWindow);
            [...chatWindow.children].forEach(child => resizeObserver.observe(child));

            new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    mutation.addedNodes.forEach(node => { if (node.nodeType === 1) resizeObserver.observe(node); });
                    mutation.removedNodes.forEach(node => { if (node.nodeType === 1) resizeObserver.unobserve(node); });
                }
            }).observe(chatWindow, { childList: true });

            // Own scrolling decides whether the view counts as "at the bottom"
            chatWindow.addEventListener('scroll', () => {
                lastScrollHeight = chatWindow.scrollHeight;
                lastClientHeight = chatWindow.clientHeight;
            }, { passive: true });
        },

        // Media players (click-to-play cards), bound once per chat window element

        setupMediaPlayers() {
            const chatWindow = document.querySelector('.chat-messages');
            if (!chatWindow || chatWindow._mediaPlayersBound) return;
            chatWindow._mediaPlayersBound = true;

            chatWindow.addEventListener('click', (e) => {
                const mediaCard = e.target.closest?.('.media-play-card');
                const youtubeCard = e.target.closest?.('.youtube-card');
                if (!mediaCard && !youtubeCard) return;
                // The card is a target="_blank" link: the desktop app would open it in the system
                // browser, so the default action must not run.
                e.preventDefault();
                e.stopPropagation();

                const player = document.createElement(mediaCard ? (mediaCard.dataset.mediaType === 'audio' ? 'audio' : 'video') : 'iframe');
                player.className = 'chat-media-player';
                if (mediaCard) {
                    player.controls = true;
                    player.autoplay = true;
                    player.src = mediaCard.href;
                } else {
                    const id = youtubeCard.dataset.youtubeId;
                    if (!/^[-\w]+$/.test(id || '')) return;
                    player.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
                    player.allow = 'autoplay; encrypted-media; picture-in-picture';
                    player.allowFullscreen = true;
                }
                (mediaCard || youtubeCard).replaceWith(player);
            });
        },

        // Input toolbar

        toggleColorPicker() { this.showColorPicker = !this.showColorPicker; this.showEmojiPicker = false; this.showGifPicker = false; },
        toggleEmojiPicker() { this.showEmojiPicker = !this.showEmojiPicker; this.showColorPicker = false; this.showGifPicker = false; },
        toggleGifPicker() { this.showGifPicker = !this.showGifPicker; this.showColorPicker = false; this.showEmojiPicker = false; },
        openColorPicker() { this.toggleColorPicker(); },

        /**
         * Insert text at the cursor (or wrap the selection) in the message input.
         */
        insertAtCursor(before, after = '') {
            const el = this.$refs.messageInput;
            if (!el) {
                this.newMessage += before + after;
                return;
            }
            const start = el.selectionStart ?? this.newMessage.length;
            const end = el.selectionEnd ?? start;
            const selected = this.newMessage.slice(start, end);
            this.newMessage = this.newMessage.slice(0, start) + before + selected + after + this.newMessage.slice(end);
            this.$nextTick(() => {
                el.focus();
                const caret = start + before.length + selected.length;
                el.setSelectionRange(caret, caret);
            });
        },

        insertColor(index) {
            const code = `\u0003${String(index).padStart(2, '0')}`;
            this.insertAtCursor(code, this.$refs.messageInput?.selectionStart !== this.$refs.messageInput?.selectionEnd ? '\u0003' : '');
            this.showColorPicker = false;
        },
        insertEmoji(emoji) { this.insertAtCursor(emoji); this.showEmojiPicker = false; },
        applyFormat(type) {
            const map = { b: '\u0002', i: '\u001D', u: '\u001F', s: '\u001E' };
            if (map[type]) this.insertAtCursor(map[type], map[type]);
        },

        /** Opens the profile card of a user next to the clicked element. */
        showUserOptions(username, event) {
            this.selectedUser = username;
            this.showingUserOptions = true;
            this._userMenuAnchor = event.target.getBoundingClientRect();
            this.loadProfileCard?.(username);
            setTimeout(() => this.positionUserMenu(), 10);
        },

        /** Also called after the card grew (profile loaded), so it stays inside the window. */
        positionUserMenu() {
            const menu = this.$refs.userMenu;
            const rect = this._userMenuAnchor;
            if (!menu || !rect || !this.showingUserOptions) return;
            const menuWidth = menu.offsetWidth;
            const leftPosition = (rect.right + menuWidth > window.innerWidth)
                ? rect.left - menuWidth - 10
                : rect.right + 10;
            const top = Math.min(rect.top, window.innerHeight - menu.offsetHeight - 10);
            menu.style.top = `${Math.max(10, top)}px`;
            menu.style.left = `${Math.max(10, leftPosition)}px`;
        },

        // Notifications

        notifyMention(sender, channel, text) {
            const ownSound = playsOwnSound(this.notificationSound);
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(this.t('notification_mention_title', { sender, channel }), {
                    body: text,
                    tag: notificationTag(channel),
                    // Own sound or "off": the system sound would ring on top of it
                    silent: this.notificationSound !== 'system',
                });
            }
            if (ownSound) this.playHighlightSound();
            this.notifyHost('mention-update', { hasMentions: true, mentionCount: this.mentionCount });
        },

        playHighlightSound() {
            const now = Date.now();
            if (now - (this._lastHighlightSoundAt || 0) < NOTIFICATION_SOUND_MIN_INTERVAL_MS) return false;
            this._lastHighlightSoundAt = now;
            return playNotificationSound(this.notificationSound);
        },

        resetMentions() {
            this.hasMentions = false;
            this.mentionCount = 0;
            this.notifyHost('mention-update', { hasMentions: false, mentionCount: 0 });
        },

        /** Unread count for the host app (taskbar badge, tab title). */
        emitUnreadState() {
            // "Only mentions" channels count their mentions, not every message
            const totalUnread = Object.entries(this.unreadMessages || {}).reduce((sum, [target, count]) => {
                const level = this.channelNotifyLevel?.(target) || 'all';
                if (level === 'mute') return sum;
                const value = level === 'mentions' ? this.mentionsByChannel?.[target] : count;
                const n = Number.isFinite(Number(value)) ? Number(value) : 0;
                return sum + Math.max(0, n);
            }, 0);
            this.notifyHost('unread-state-update', { totalUnread });
        },

        /** Light or dark colours ([data-bs-theme=light|dark] in the theme CSS). */
        applyTheme(theme) {
            document.documentElement.setAttribute('data-bs-theme', theme === 'light' ? 'light' : 'dark');
        },
    };
}
