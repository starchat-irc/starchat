/**
 * IRC line parser (RFC 1459 + IRCv3 message-tags).
 * No DOM or framework dependencies.
 */

const TAG_ESCAPES = { ':': ';', 's': ' ', '\\': '\\', 'r': '\r', 'n': '\n' };

/**
 * Unescape an IRCv3 tag value (`\:` → `;`, `\s` → space, ...).
 *
 * @param {string|undefined} value
 * @return {string|undefined}
 */
export function unescapeTagValue(value) {
    if (value === undefined) return undefined;
    let result = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch !== '\\') { result += ch; continue; }
        const next = value[i + 1];
        if (next === undefined) break; // trailing backslash is dropped
        result += TAG_ESCAPES[next] ?? next;
        i++;
    }
    return result;
}

/**
 * Escape a value for use in an outgoing IRCv3 tag.
 *
 * @param {string} value
 * @return {string}
 */
export function escapeTagValue(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\:')
        .replace(/ /g, '\\s')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

/**
 * Parse the tag section of an IRC line (without the leading `@`). Values are
 * unescaped; valueless tags (and `key=`) map to undefined. A repeated key keeps
 * its last value, as the IRCv3 spec requires.
 *
 * @param {string} tagString e.g. "time=2026-01-01T00:00:00Z;+typing=active;bot"
 * @return {Object<string, string|undefined>}
 */
export function parseIrcTags(tagString) {
    const tags = {};
    for (const pair of String(tagString ?? '').split(';')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        if (!key) continue;
        const value = eq === -1 ? undefined : unescapeTagValue(pair.slice(eq + 1));
        tags[key] = value === '' ? undefined : value;
    }
    return tags;
}

/**
 * @typedef {Object} IrcMessage
 * @property {string} raw
 * @property {Object<string, string|undefined>} tags   Unescaped tag values; valueless tags map to undefined.
 * @property {string} source  Full prefix without the leading colon (e.g. "nick!user@host" or "irc.server").
 * @property {string} nick    Nick part of the source (or the server name).
 * @property {boolean} fromServer  True when the source is a server, not a user.
 * @property {string} command Upper-cased command or 3-digit numeric.
 * @property {string[]} params Middle params plus the trailing param (if any) as the last element.
 * @property {boolean} hasTrailing
 */

/**
 * Parse a single raw IRC line.
 *
 * @param {string} line
 * @return {IrcMessage}
 */
export function parseIrcLine(line) {
    let rest = String(line ?? '').replace(/[\r\n]+$/, '');
    const raw = rest;
    let tags = {};

    if (rest.startsWith('@')) {
        const end = rest.indexOf(' ');
        const tagString = end === -1 ? rest.slice(1) : rest.slice(1, end);
        rest = end === -1 ? '' : rest.slice(end + 1).replace(/^ +/, '');
        tags = parseIrcTags(tagString);
    }

    let source = '';
    if (rest.startsWith(':')) {
        const end = rest.indexOf(' ');
        source = end === -1 ? rest.slice(1) : rest.slice(1, end);
        rest = end === -1 ? '' : rest.slice(end + 1).replace(/^ +/, '');
    }

    const params = [];
    let hasTrailing = false;
    let command = '';

    const trailingIndex = rest.indexOf(' :');
    let middle = rest;
    let trailing = null;
    if (rest.startsWith(':')) {
        middle = '';
        trailing = rest.slice(1);
    } else if (trailingIndex !== -1) {
        middle = rest.slice(0, trailingIndex);
        trailing = rest.slice(trailingIndex + 2);
    }

    const middleParts = middle.split(' ').filter(Boolean);
    command = (middleParts.shift() || '').toUpperCase();
    params.push(...middleParts);
    if (trailing !== null) {
        params.push(trailing);
        hasTrailing = true;
    }

    const bangIndex = source.indexOf('!');
    const nick = bangIndex === -1 ? source.split('@')[0] : source.slice(0, bangIndex);
    const fromServer = source !== '' && bangIndex === -1 && !source.includes('@') && source.includes('.');

    return { raw, tags, source, nick, fromServer, command, params, hasTrailing };
}
