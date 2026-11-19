/**
 * Text formatting helpers for chat messages: mIRC control codes, mentions and emotes.
 * No DOM or framework dependencies.
 */

export const MIRC_COLORS = [
    '#FFFFFF', '#000000', '#00007F', '#009300', '#FF0000', '#7F0000', '#9C009C', '#FC7F00',
    '#FFFF00', '#00FC00', '#009393', '#00FFFF', '#0000FC', '#FF00FF', '#7F7F7F', '#D2D2D2',
];

export const DEFAULT_EMOTES = { ':D': '😃', ':P': '😛', ';)': '😉', ':(': '😞', ':)': '🙂', '<3': '❤️' };

/** Characters allowed in IRC nicknames (RFC 2812 + common extensions). */
const NICK_CHARS = 'A-Za-z0-9\\[\\]\\\\`_^{|}\\-';

const B = '\x02', C = '\x03', H = '\x04', R = '\x0F', M = '\x11', V = '\x16', S = '\x1E', I = '\x1D', U = '\x1F';

export function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove all mIRC formatting control codes from a string.
 *
 * @param {string} text
 * @return {string}
 */
export function stripFormatting(text) {
    return String(text ?? '')
        .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
        .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, '')
        .replace(/[\x02\x0F\x11\x16\x1D\x1E\x1F]/g, '');
}

/**
 * Convert mIRC formatting codes into HTML. All text is HTML-escaped.
 * Supports bold, italic, underline, strikethrough, monospace, reverse, reset,
 * 16-colour codes (\x03fg,bg) and hex colours (\x04RRGGBB,RRGGBB).
 *
 * @param {string} text
 * @param {string[]} palette
 * @return {string}
 */
export function mircToHtml(text, palette = MIRC_COLORS) {
    const input = String(text ?? '');
    const fresh = () => ({ b: false, i: false, u: false, s: false, m: false, rev: false, fg: null, bg: null });
    let state = fresh();
    let buffer = '';
    let html = '';

    const flush = () => {
        if (!buffer) return;
        const escaped = escapeHtml(buffer);
        buffer = '';
        const classes = [];
        if (state.b) classes.push('irc-b');
        if (state.i) classes.push('irc-i');
        if (state.u) classes.push('irc-u');
        if (state.s) classes.push('irc-s');
        if (state.m) classes.push('irc-m');
        let fg = state.fg;
        let bg = state.bg;
        if (state.rev) {
            if (fg || bg) { [fg, bg] = [bg, fg]; } else { classes.push('irc-reverse'); }
        }
        const styles = [];
        if (fg) styles.push(`color:${fg}`);
        if (bg) styles.push(`background-color:${bg}`);
        if (bg) classes.push('irc-bg');
        if (!classes.length && !styles.length) {
            html += escaped;
            return;
        }
        const classAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
        const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
        html += `<span${classAttr}${styleAttr}>${escaped}</span>`;
    };

    const paletteColor = (code) => {
        const index = parseInt(code, 10);
        return Number.isInteger(index) && index >= 0 && index < palette.length ? palette[index] : null;
    };

    for (let pos = 0; pos < input.length; pos++) {
        const ch = input[pos];
        switch (ch) {
            case B: flush(); state.b = !state.b; break;
            case I: flush(); state.i = !state.i; break;
            case U: flush(); state.u = !state.u; break;
            case S: flush(); state.s = !state.s; break;
            case M: flush(); state.m = !state.m; break;
            case V: flush(); state.rev = !state.rev; break;
            case R: flush(); state = fresh(); break;
            case C: {
                flush();
                const match = /^(\d{1,2})(?:,(\d{1,2}))?/.exec(input.slice(pos + 1));
                if (!match) {
                    state.fg = null;
                    state.bg = null;
                    break;
                }
                state.fg = match[1] === '99' ? null : paletteColor(match[1]);
                if (match[2] !== undefined) state.bg = match[2] === '99' ? null : paletteColor(match[2]);
                pos += match[0].length;
                break;
            }
            case H: {
                flush();
                const match = /^([0-9a-fA-F]{6})(?:,([0-9a-fA-F]{6}))?/.exec(input.slice(pos + 1));
                if (!match) {
                    state.fg = null;
                    state.bg = null;
                    break;
                }
                state.fg = `#${match[1]}`;
                if (match[2] !== undefined) state.bg = `#${match[2]}`;
                pos += match[0].length;
                break;
            }
            default:
                // Drop remaining control characters except newline/tab
                if (ch < ' ' && ch !== '\n' && ch !== '\t') break;
                buffer += ch;
        }
    }
    flush();
    return html;
}

const mentionRegexCache = new Map();

/**
 * Regex matching the given nick as a standalone word (optionally prefixed with @), case-insensitive.
 * Group 1 is the preceding character (or empty at start), group 2 the mention itself.
 */
function nickRegex(nick) {
    if (!mentionRegexCache.has(nick)) {
        mentionRegexCache.set(nick, new RegExp(`(^|[^${NICK_CHARS}@])(@?${escapeRegExp(nick)})(?![${NICK_CHARS}])`, 'i'));
    }
    return mentionRegexCache.get(nick);
}

/**
 * Whether the message text mentions the nick (bare or as @nick, case-insensitive).
 *
 * @param {string} text
 * @param {string} nick
 * @return {boolean}
 */
export function isNickMentioned(text, nick) {
    if (!text || !nick) return false;
    return nickRegex(nick).test(stripFormatting(text));
}

export const HIGHLIGHT_WORDS_LIMIT = 20;
export const HIGHLIGHT_WORD_MAX_LENGTH = 50;

/**
 * Clean a list of highlight words: trimmed, without duplicates (case-insensitive),
 * limited in count and length. Accepts an array or a comma/newline separated string.
 *
 * @param {string[]|string} input
 * @return {string[]}
 */
export function normalizeHighlightWords(input) {
    const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,\n]/);
    const seen = new Set();
    const words = [];
    for (const entry of raw) {
        const word = String(entry ?? '').trim().slice(0, HIGHLIGHT_WORD_MAX_LENGTH);
        if (!word || seen.has(word.toLowerCase())) continue;
        seen.add(word.toLowerCase());
        words.push(word);
        if (words.length === HIGHLIGHT_WORDS_LIMIT) break;
    }
    return words;
}

/** Regex alternation for highlight words, longest first so "Enterprise-E" wins over "Enterprise". */
function highlightAlternation(words) {
    return [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
}

const highlightRegexCache = new Map();

function highlightRegex(words) {
    const key = words.join('\n').toLowerCase();
    if (!highlightRegexCache.has(key)) {
        if (highlightRegexCache.size > 20) highlightRegexCache.clear();
        highlightRegexCache.set(key, new RegExp(`(^|[^${NICK_CHARS}@])(?:${highlightAlternation(words)})(?![${NICK_CHARS}])`, 'i'));
    }
    return highlightRegexCache.get(key);
}

/**
 * Whether the message should alert the user: it mentions the nick or contains one of
 * the user's highlight words (whole word, case-insensitive).
 *
 * @param {string} text
 * @param {string} nick
 * @param {string[]} words
 * @return {boolean}
 */
export function isHighlighted(text, nick, words = []) {
    if (!text) return false;
    if (isNickMentioned(text, nick)) return true;
    return words.length > 0 && highlightRegex(words).test(stripFormatting(text));
}

/**
 * Turn a plain text fragment into HTML, highlighting mentions and replacing emotes.
 * The fragment must be plain text (e.g. a DOM text node), the result is escaped HTML.
 *
 * @param {string} text
 * @param {{ nick?: string, emotes?: Object<string, string>, highlightWords?: string[] }} options
 * @return {string}
 */
export function decorateText(text, { nick = '', emotes = DEFAULT_EMOTES, highlightWords = [] } = {}) {
    const emoteKeys = Object.keys(emotes).map(escapeRegExp).join('|');
    const alternatives = [];
    if (nick) alternatives.push(`(?<me>@?${escapeRegExp(nick)})(?![${NICK_CHARS}])`);
    if (highlightWords.length) alternatives.push(`(?<word>${highlightAlternation(highlightWords)})(?![${NICK_CHARS}])`);
    alternatives.push(`(?<at>@[${NICK_CHARS}]+)`);
    if (emoteKeys) alternatives.push(`(?<emote>${emoteKeys})(?=$|[\\s.,!?])`);

    const regex = new RegExp(`(?<pre>^|[^${NICK_CHARS}@])(?:${alternatives.join('|')})`, 'gi');
    let html = '';
    let last = 0;

    for (const match of String(text).matchAll(regex)) {
        const { pre, me, word, at, emote } = match.groups;
        html += escapeHtml(text.slice(last, match.index)) + escapeHtml(pre);
        if (me) {
            html += `<span class="mention mention--me">${escapeHtml(me)}</span>`;
        } else if (word) {
            html += `<span class="mention mention--me mention--word">${escapeHtml(word)}</span>`;
        } else if (at) {
            html += `<span class="mention">${escapeHtml(at)}</span>`;
        } else if (emote) {
            const replacement = emotes[emote] ?? emotes[emote.toUpperCase()];
            html += replacement ? `<span class="emote" title="${escapeHtml(emote)}">${replacement}</span>` : escapeHtml(emote);
        }
        last = match.index + match[0].length;
    }
    return html + escapeHtml(text.slice(last));
}

/**
 * Format an epoch timestamp as HH:MM.
 *
 * @param {number} ts
 * @param {string} [locale] Defaults to the runtime locale.
 * @return {string}
 */
export function formatClock(ts, locale) {
    return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Label for a day separator: "Today", "Yesterday" (localised via labels) or a full date.
 *
 * @param {number} ts
 * @param {{ now?: number, today?: string, yesterday?: string, locale?: string }} options
 * @return {string}
 */
export function formatDayLabel(ts, { now = Date.now(), today = 'Today', yesterday = 'Yesterday', locale } = {}) {
    const diffDays = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
    if (diffDays === 0) return today;
    if (diffDays === 1) return yesterday;
    return new Date(ts).toLocaleDateString(locale, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

export function startOfDay(ts) {
    const date = new Date(ts);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

/**
 * Stable hue (0–359) for a nickname, used for nick colouring.
 *
 * @param {string} nick
 * @return {number}
 */
export function nickHue(nick) {
    let hash = 0;
    const value = String(nick ?? '').toLowerCase();
    for (let i = 0; i < value.length; i++) {
        hash = value.charCodeAt(i) + ((hash << 5) - hash);
        hash |= 0;
    }
    return Math.abs(hash) % 360;
}
