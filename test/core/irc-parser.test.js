import { test } from 'vitest';
import assert from 'node:assert/strict';
import { escapeTagValue, parseIrcLine, parseIrcTags, unescapeTagValue } from '../../src/core/irc-parser.js';

test('parses source, command and trailing param', () => {
    const msg = parseIrcLine(':nick!user@host PRIVMSG #Chan :hello: world');
    assert.equal(msg.nick, 'nick');
    assert.equal(msg.source, 'nick!user@host');
    assert.equal(msg.command, 'PRIVMSG');
    assert.deepEqual(msg.params, ['#Chan', 'hello: world']);
    assert.equal(msg.fromServer, false);
});

test('parses tags and unescapes their values', () => {
    const msg = parseIrcLine('@time=2026-10-24T10:00:00.000Z;msgid=a\\sb\\:c;+typing=active;draft/multiline-concat :n!u@h TAGMSG #c');
    assert.equal(msg.tags.time, '2026-10-24T10:00:00.000Z');
    assert.equal(msg.tags.msgid, 'a b;c');
    assert.equal(msg.tags['+typing'], 'active');
    assert.ok('draft/multiline-concat' in msg.tags);
    assert.equal(msg.tags['draft/multiline-concat'], undefined);
    assert.equal(msg.command, 'TAGMSG');
    assert.deepEqual(msg.params, ['#c']);
});

test('parses numerics from servers', () => {
    const msg = parseIrcLine(':irc.example.net 353 me = #chan :@op +voice user');
    assert.equal(msg.fromServer, true);
    assert.equal(msg.command, '353');
    assert.deepEqual(msg.params, ['me', '=', '#chan', '@op +voice user']);
});

test('handles hosts containing colons (IPv6) without breaking params', () => {
    const msg = parseIrcLine(':irc.example.net 352 me #chan ~u 2001:db8::1 irc.example.net nick H@ :0 Real Name');
    assert.deepEqual(msg.params, ['me', '#chan', '~u', '2001:db8::1', 'irc.example.net', 'nick', 'H@', '0 Real Name']);
});

test('parses lines without a source', () => {
    const msg = parseIrcLine('PING :token');
    assert.equal(msg.source, '');
    assert.equal(msg.command, 'PING');
    assert.deepEqual(msg.params, ['token']);
});

test('keeps empty trailing params', () => {
    const msg = parseIrcLine(':n!u@h TOPIC #c :');
    assert.deepEqual(msg.params, ['#c', '']);
    assert.equal(msg.hasTrailing, true);
});

test('tag escaping round-trips', () => {
    const value = 'a b;c\\d';
    assert.equal(unescapeTagValue(escapeTagValue(value)), value);
});

test('parseIrcTags unescapes every IRCv3 escape sequence', () => {
    const tags = parseIrcTags(String.raw`a=x\:y;b=1\s2;c=back\\slash;d=line\rbreak\n`);
    assert.equal(tags.a, 'x;y');
    assert.equal(tags.b, '1 2');
    assert.equal(tags.c, String.raw`back\slash`);
    assert.equal(tags.d, 'line\rbreak\n');
});

test('parseIrcTags drops a trailing backslash and keeps unknown escapes as the plain char', () => {
    const tags = parseIrcTags(String.raw`a=end\;b=\b\x`);
    assert.equal(tags.a, 'end');
    assert.equal(tags.b, 'bx');
});

test('parseIrcTags treats missing and empty values alike and lets the last duplicate win', () => {
    const tags = parseIrcTags('bot;empty=;+draft/reply=1;+draft/reply=2;;=orphan');
    assert.ok('bot' in tags);
    assert.equal(tags.bot, undefined);
    assert.ok('empty' in tags);
    assert.equal(tags.empty, undefined);
    assert.equal(tags['+draft/reply'], '2');
    assert.ok(!('' in tags));
});

test('parseIrcTags keeps equals signs inside values', () => {
    assert.equal(parseIrcTags('k=a=b').k, 'a=b');
});

test('parseIrcTags tolerates empty input', () => {
    assert.deepEqual(parseIrcTags(''), {});
    assert.deepEqual(parseIrcTags(undefined), {});
});
