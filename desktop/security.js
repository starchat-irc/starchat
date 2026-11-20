'use strict';

/**
 * Pure security helpers for the Electron main process.
 * Kept free of Electron imports so they can be unit-tested with `node --test`.
 */

const path = require('path');

const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Only http(s)/mailto URLs may be handed to the OS. Everything else
 * (file:, smb:, ms-msdt:, search-ms:, javascript: …) is refused.
 */
function isSafeExternalUrl(url) {
    try {
        return EXTERNAL_URL_PROTOCOLS.has(new URL(String(url)).protocol);
    } catch {
        return false;
    }
}

/** Exact origin comparison: substring checks like `includes()` are spoofable. */
function isSameOrigin(url, origin) {
    try {
        return !!origin && new URL(String(url)).origin === origin;
    } catch {
        return false;
    }
}

/** True for file:// URLs that point to a file inside `directory`. */
function isFileUrlInside(url, directory) {
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol !== 'file:') return false;
        // file:///C:/foo → C:/foo on Windows, /foo elsewhere
        const pathname = decodeURIComponent(parsed.pathname);
        const filePath = path.resolve(/^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname);
        const relative = path.relative(path.resolve(directory), filePath);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch {
        return false;
    }
}

/**
 * Resolves a log file name inside the log directory.
 * Returns null for anything that is not a plain *.log file name (path traversal guard).
 */
function resolveLogFilePath(logDir, filename) {
    if (typeof filename !== 'string' || !filename.endsWith('.log')) return null;
    if (filename !== path.basename(filename) || filename.includes('/') || filename.includes('\\')) return null;
    const resolved = path.resolve(logDir, filename);
    return path.dirname(resolved) === path.resolve(logDir) ? resolved : null;
}

/** IRC lines must never smuggle additional commands via CR/LF/NUL. */
function sanitizeIrcLine(line) {
    return String(line || '').replace(/[\r\n\0]/g, ' ');
}

/** Strip credentials from IRC lines before they reach a log file. */
function redactIrcLine(line) {
    return String(line || '').replace(/^(PASS|AUTHENTICATE|OPER)\b.*$/i, '$1 <redacted>').slice(0, 200);
}

/** A native socket may only dial the host/port stored in the profile's external server config. */
function isConfiguredSocketTarget(externalServer, host, port) {
    const portNumber = Number(port);
    if (!externalServer || !host || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        return false;
    }
    return String(externalServer.host || '').toLowerCase() === String(host).toLowerCase()
        && Number(externalServer.port) === portNumber;
}

/** Host name or IP literal plus a port in range: used before dialing a test connection. */
function isValidConnectionTarget(host, port) {
    const portNumber = Number(port);
    return typeof host === 'string'
        && /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/.test(host.trim())
        && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
}

/** Map a socket/TLS error to a short, translatable reason. */
function connectionErrorReason(error) {
    const code = String(error?.code || '');
    if (code === 'ETIMEDOUT' || /timeout/i.test(error?.message || '')) return 'timeout';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'not-found';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT/i.test(code)) return 'certificate';
    if (/SSL|TLS|EPROTO/i.test(code) || /wrong version number|ssl/i.test(error?.message || '')) return 'tls';
    return 'unknown';
}

/**
 * Voice chat: the bundled chat (a file inside generated/chat) may use the microphone.
 * The camera stays off for everyone, and no other page gets the microphone.
 */
function isAllowedMediaRequest(details, chatDistDirectory) {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    if (!mediaTypes.includes('audio') || mediaTypes.includes('video')) return false;
    return isFileUrlInside(details?.requestingUrl, chatDistDirectory);
}

module.exports = {
    isValidConnectionTarget,
    isAllowedMediaRequest,
    connectionErrorReason,
    isSafeExternalUrl,
    isSameOrigin,
    isFileUrlInside,
    resolveLogFilePath,
    sanitizeIrcLine,
    redactIrcLine,
    isConfiguredSocketTarget,
};
