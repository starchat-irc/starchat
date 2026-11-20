import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import security from '../security.js';

const desktopDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const {
    isSafeExternalUrl,
    isSameOrigin,
    isFileUrlInside,
    resolveLogFilePath,
    sanitizeIrcLine,
    redactIrcLine,
    isConfiguredSocketTarget,
    isAllowedMediaRequest,
} = security;

test('isSafeExternalUrl allows only http, https and mailto', () => {
    assert.equal(isSafeExternalUrl('https://example.com/a'), true);
    assert.equal(isSafeExternalUrl('http://example.com'), true);
    assert.equal(isSafeExternalUrl('mailto:info@example.com'), true);

    for (const url of ['file:///C:/Windows/win.ini', 'smb://evil/share', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'javascript:alert(1)', 'not a url', '', null]) {
        assert.equal(isSafeExternalUrl(url), false, String(url));
    }
});

test('isSameOrigin compares exact origins and cannot be spoofed by substrings', () => {
    const origin = 'https://st-city.net';
    assert.equal(isSameOrigin('https://st-city.net/app', origin), true);
    assert.equal(isSameOrigin('https://evil.com/?https://st-city.net/app', origin), false);
    assert.equal(isSameOrigin('https://st-city.net.evil.com/', origin), false);
    assert.equal(isSameOrigin('http://st-city.net/', origin), false);
    assert.equal(isSameOrigin('https://st-city.net/', null), false);
});

test('isFileUrlInside only accepts files inside the given directory', () => {
    const dir = desktopDir;
    const inside = new URL(`file:///${path.join(dir, 'chat-dist', 'index.html').replace(/\\/g, '/').replace(/^\//, '')}`).href;

    assert.equal(isFileUrlInside(inside, dir), true);
    assert.equal(isFileUrlInside(new URL('../.env', inside.replace('chat-dist/index.html', '')).href, dir), false);
    assert.equal(isFileUrlInside('file:///C:/Windows/win.ini', dir), false);
    assert.equal(isFileUrlInside('https://st-city.net/', dir), false);
});

test('isFileUrlInside follows the path rules of each system', () => {
    const posix = { windows: false, path: path.posix };
    const windows = { windows: true, path: path.win32 };

    assert.equal(isFileUrlInside('file:///opt/app/html/index.html', '/opt/app', posix), true);
    assert.equal(isFileUrlInside('file:///opt/app/../secret', '/opt/app', posix), false);
    // A drive letter is no relative path on Linux or macOS: never inside the working directory
    assert.equal(isFileUrlInside('file:///C:/Windows/win.ini', '/opt/app', posix), false);

    assert.equal(isFileUrlInside('file:///C:/app/html/index.html', 'C:\\app', windows), true);
    assert.equal(isFileUrlInside('file:///D:/app/html/index.html', 'C:\\app', windows), false);
    assert.equal(isFileUrlInside('file:///C:/app/../secret', 'C:\\app', windows), false);
});

test('resolveLogFilePath rejects path traversal and non-log files', () => {
    const logDir = path.resolve('logs');

    assert.equal(resolveLogFilePath(logDir, 'lobby-2026-11-09.log'), path.join(logDir, 'lobby-2026-11-09.log'));
    assert.equal(resolveLogFilePath(logDir, '../secret.log'), null);
    assert.equal(resolveLogFilePath(logDir, '..\\..\\secret.log'), null);
    assert.equal(resolveLogFilePath(logDir, 'sub/x.log'), null);
    assert.equal(resolveLogFilePath(logDir, 'C:\\x.log'), null);
    assert.equal(resolveLogFilePath(logDir, 'main.json'), null);
    assert.equal(resolveLogFilePath(logDir, undefined), null);
});

test('sanitizeIrcLine prevents command injection via line breaks', () => {
    assert.equal(sanitizeIrcLine('PRIVMSG #a :hi\r\nQUIT :bye'), 'PRIVMSG #a :hi  QUIT :bye');
    assert.equal(sanitizeIrcLine('a\0b'), 'a b');
    assert.equal(sanitizeIrcLine(undefined), '');
});

test('redactIrcLine hides credentials and truncates', () => {
    assert.equal(redactIrcLine('PASS hunter2'), 'PASS <redacted>');
    assert.equal(redactIrcLine('authenticate dXNlcjpwYXNz'), 'authenticate <redacted>');
    assert.equal(redactIrcLine('OPER admin secret'), 'OPER <redacted>');
    assert.equal(redactIrcLine('PRIVMSG #a :PASS'), 'PRIVMSG #a :PASS');
    assert.equal(redactIrcLine('x'.repeat(500)).length, 200);
});

test('isConfiguredSocketTarget only allows the profile server', () => {
    const ext = { host: 'irc.example.net', port: '6697' };

    assert.equal(isConfiguredSocketTarget(ext, 'IRC.example.net', 6697), true);
    assert.equal(isConfiguredSocketTarget(ext, 'irc.example.net', 6667), false);
    assert.equal(isConfiguredSocketTarget(ext, '127.0.0.1', 6697), false);
    assert.equal(isConfiguredSocketTarget(null, 'irc.example.net', 6697), false);
    assert.equal(isConfiguredSocketTarget({ host: 'x', port: 0 }, 'x', 0), false);
    assert.equal(isConfiguredSocketTarget({ host: 'x', port: 70000 }, 'x', 70000), false);
});

test('isValidConnectionTarget accepts host names and IP literals with a port in range', () => {
    const { isValidConnectionTarget } = security;
    assert.equal(isValidConnectionTarget('irc.libera.chat', 6697), true);
    assert.equal(isValidConnectionTarget('127.0.0.1', '6667'), true);
    assert.equal(isValidConnectionTarget('[::1]', 6697), true);
    assert.equal(isValidConnectionTarget('ircs://irc.libera.chat', 6697), false);
    assert.equal(isValidConnectionTarget('irc.libera.chat/x', 6697), false);
    assert.equal(isValidConnectionTarget('irc.libera.chat', 0), false);
    assert.equal(isValidConnectionTarget('irc.libera.chat', 65536), false);
    assert.equal(isValidConnectionTarget(null, 6697), false);
});

test('connectionErrorReason maps socket errors to short reasons', () => {
    const { connectionErrorReason } = security;
    assert.equal(connectionErrorReason({ code: 'ECONNREFUSED' }), 'refused');
    assert.equal(connectionErrorReason({ code: 'ENOTFOUND' }), 'not-found');
    assert.equal(connectionErrorReason({ code: 'ETIMEDOUT' }), 'timeout');
    assert.equal(connectionErrorReason({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'certificate');
    assert.equal(connectionErrorReason({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), 'tls');
    assert.equal(connectionErrorReason({ code: 'EWHATEVER' }), 'unknown');
});

test('isAllowedMediaRequest grants the microphone to the bundled chat only, never the camera', () => {
    const chatDist = path.join(desktopDir, 'generated', 'chat');
    const chatUrl = `${pathToFileURL(path.join(chatDist, 'index.html')).href}?profile=abc`;
    const shellUrl = pathToFileURL(path.join(desktopDir, 'html', 'index.html')).href;

    assert.equal(isAllowedMediaRequest({ mediaTypes: ['audio'], requestingUrl: chatUrl }, chatDist), true);
    assert.equal(isAllowedMediaRequest({ mediaTypes: ['audio', 'video'], requestingUrl: chatUrl }, chatDist), false);
    assert.equal(isAllowedMediaRequest({ mediaTypes: ['video'], requestingUrl: chatUrl }, chatDist), false);
    assert.equal(isAllowedMediaRequest({ mediaTypes: ['audio'], requestingUrl: shellUrl }, chatDist), false);
    assert.equal(isAllowedMediaRequest({ mediaTypes: ['audio'], requestingUrl: 'https://www.youtube.com/embed/x' }, chatDist), false);
    assert.equal(isAllowedMediaRequest({}, chatDist), false);
});

test('the chat iframe delegates the microphone with a wildcard (file:// pages have opaque origins)', () => {
    const shell = readFileSync(path.join(desktopDir, 'html', 'index.html'), 'utf8');
    const allow = shell.match(/<iframe :id="'chatFrame-'[\s\S]*?allow="([^"]*)"/)?.[1] || '';

    // allow="microphone" would only delegate to the src origin: never matches for file://
    assert.match(allow, /(^|;)\s*microphone \*/);
});
