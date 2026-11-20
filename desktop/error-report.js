'use strict';

/**
 * Local error log for renderer errors (window.onerror, unhandled rejections, crashed
 * renderers). Entries stay on this machine: the user copies a report to the clipboard
 * from the settings window and decides themselves where to send it.
 *
 * Free of Electron imports so it can be unit-tested with an in-memory fs.
 */

const MAX_ENTRIES = 200;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_STACK_LENGTH = 4000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;

const KINDS = ['error', 'unhandledrejection', 'crash'];
const SOURCES = ['shell', 'chat', 'main'];

/** Query params and headers that must never end up in a report. */
const SECRET_PATTERNS = [
    [/([?&#](?:token|access_token|refresh_token|password|code|sig|signature)=)[^&#\s'"]+/gi, '$1[redacted]'],
    [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]'],
];

/**
 * @param {unknown} value
 * @param {number} limit
 * @return {string}
 */
function scrub(value, limit) {
    let text = value === undefined || value === null ? '' : String(value);
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        text = text.replace(pattern, replacement);
    }
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Bring an untrusted payload from a renderer into a fixed shape.
 *
 * @param {Record<string, unknown>} raw
 * @param {Date} now
 * @return {{ time: string, kind: string, source: string, message: string, location: string, stack: string }|null}
 */
function normalizeEntry(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const message = scrub(raw.message, MAX_MESSAGE_LENGTH).trim();
    if (!message) return null;

    const file = scrub(raw.filename, 300);
    const line = Number.isInteger(raw.lineno) ? raw.lineno : null;
    const column = Number.isInteger(raw.colno) ? raw.colno : null;
    const location = file ? [file, line, column].filter(part => part !== null).join(':') : '';

    return {
        time: now.toISOString(),
        kind: KINDS.includes(raw.kind) ? raw.kind : 'error',
        source: SOURCES.includes(raw.source) ? raw.source : 'shell',
        message,
        location,
        stack: scrub(raw.stack, MAX_STACK_LENGTH),
    };
}

/**
 * @param {{
 *   appName?: string,
 *   filePath: string,
 *   fs: { readFileSync: Function, writeFileSync: Function, mkdirSync: Function, existsSync: Function },
 *   dirname: (path: string) => string,
 *   now?: () => Date,
 *   maxEntries?: number,
 *   rateLimit?: number,
 *   logger?: { warn: Function },
 * }} options
 */
function createErrorLog({
    appName = 'StarChat',
    filePath,
    fs,
    dirname,
    now = () => new Date(),
    maxEntries = MAX_ENTRIES,
    rateLimit = RATE_LIMIT,
    logger = console,
}) {
    let entries = load();
    let windowStart = 0;
    let windowCount = 0;

    function load() {
        try {
            if (!fs.existsSync(filePath)) return [];
            return String(fs.readFileSync(filePath, 'utf8'))
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null; // a torn line from a crash: skip it
                    }
                })
                .filter(entry => entry && typeof entry.message === 'string')
                .slice(-maxEntries);
        } catch (error) {
            logger.warn('Could not read the error log:', error?.message || error);
            return [];
        }
    }

    function persist() {
        try {
            fs.mkdirSync(dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
        } catch (error) {
            logger.warn('Could not write the error log:', error?.message || error);
        }
    }

    /** An error loop must not flood the disk: at most rateLimit entries per minute. */
    function allowed(time) {
        if (time - windowStart >= RATE_WINDOW_MS) {
            windowStart = time;
            windowCount = 0;
        }
        windowCount++;
        return windowCount <= rateLimit;
    }

    return {
        /**
         * @return {boolean} true when the entry was stored
         */
        record(raw) {
            const date = now();
            const entry = normalizeEntry(raw, date);
            if (!entry || !allowed(date.getTime())) return false;

            const previous = entries[entries.length - 1];
            if (previous && previous.message === entry.message && previous.location === entry.location && previous.kind === entry.kind) {
                // The same error again (e.g. in a render loop): count it instead of repeating it
                previous.repeated = (previous.repeated || 1) + 1;
                previous.time = entry.time;
            } else {
                entries.push(entry);
                if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
            }
            persist();
            return true;
        },

        entries() {
            return entries.map(entry => ({ ...entry }));
        },

        count() {
            return entries.length;
        },

        clear() {
            entries = [];
            persist();
        },

        /**
         * Plain-text report for the clipboard.
         *
         * @param {{ version?: string, platform?: string, arch?: string, electron?: string, os?: string }} meta
         * @return {string}
         */
        buildReport(meta = {}) {
            const header = [
                `${appName} error report`,
                `Version: ${meta.version || '?'} · Electron ${meta.electron || '?'} · ${meta.platform || '?'} ${meta.arch || ''} ${meta.os || ''}`.trim(),
                `Created: ${now().toISOString()}`,
                `Entries: ${entries.length}`,
            ];
            if (!entries.length) return [...header, '', 'No errors logged.'].join('\n');

            const body = entries.map((entry) => {
                const repeated = entry.repeated > 1 ? ` (×${entry.repeated})` : '';
                const lines = [`[${entry.time}] ${entry.source}/${entry.kind}${repeated}: ${entry.message}`];
                if (entry.location) lines.push(`    at ${entry.location}`);
                if (entry.stack) lines.push(...entry.stack.split('\n').map(line => `    ${line.trim()}`));
                return lines.join('\n');
            });
            return [...header, '', ...body].join('\n');
        },
    };
}

module.exports = { createErrorLog, normalizeEntry, scrub, MAX_ENTRIES, RATE_LIMIT };
