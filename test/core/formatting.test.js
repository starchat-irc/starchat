import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
    decorateText,
    formatDayLabel,
    isHighlighted,
    isNickMentioned,
    mircToHtml,
    nickHue,
    normalizeHighlightWords,
    stripFormatting,
} from '../../src/core/formatting.js';

test('mircToHtml escapes plain text', () => {
    assert.equal(mircToHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});

test('mircToHtml handles bold toggles and reset', () => {
    assert.equal(mircToHtml('a\x02b\x02c'), 'a<span class="irc-b">b</span>c');
    assert.equal(mircToHtml('\x02\x1Dbi\x0Fplain'), '<span class="irc-b irc-i">bi</span>plain');
});

test('mircToHtml handles unterminated formatting', () => {
    assert.equal(mircToHtml('x\x1Fy'), 'x<span class="irc-u">y</span>');
});

test('mircToHtml applies foreground and background colours', () => {
    assert.equal(mircToHtml('\x034red'), '<span style="color:#FF0000">red</span>');
    assert.equal(
        mircToHtml('\x0304,01x'),
        '<span class="irc-bg" style="color:#FF0000;background-color:#000000">x</span>',
    );
});

test('mircToHtml keeps a comma that is not part of a colour code', () => {
    assert.equal(mircToHtml('\x034,hi'), '<span style="color:#FF0000">,hi</span>');
});

test('mircToHtml resets colours on a bare colour code', () => {
    assert.equal(mircToHtml('\x034a\x03b'), '<span style="color:#FF0000">a</span>b');
});

test('mircToHtml supports hex colours and drops unknown control characters', () => {
    assert.equal(mircToHtml('\x04FF8800o\x07k'), '<span style="color:#FF8800">ok</span>');
});

test('mircToHtml keeps newlines', () => {
    assert.equal(mircToHtml('a\nb'), 'a\nb');
});

test('stripFormatting removes all control codes', () => {
    assert.equal(stripFormatting('\x02\x0304,01Hi\x0F \x1Dthere\x1D'), 'Hi there');
});

test('isNickMentioned matches bare and @ mentions case-insensitively', () => {
    assert.ok(isNickMentioned('Alice: guck mal', 'alice'));
    assert.ok(isNickMentioned('hey @ALICE!', 'alice'));
    assert.ok(isNickMentioned('hey \x02alice\x02', 'alice'));
});

test('isNickMentioned respects word boundaries and IRC nick characters', () => {
    assert.ok(!isNickMentioned('alicei ist da', 'alice'));
    assert.ok(!isNickMentioned('alice_ ist da', 'alice'));
    assert.ok(!isNickMentioned('mail an foo@alice.de', 'alice'));
    assert.ok(isNickMentioned('[away] hallo', '[away]'));
    assert.ok(!isNickMentioned('', 'alice'));
});

test('decorateText highlights own mention differently from other mentions', () => {
    assert.equal(
        decorateText('hi alice und @bob', { nick: 'alice' }),
        'hi <span class="mention mention--me">alice</span> und <span class="mention">@bob</span>',
    );
});

test('decorateText replaces emotes only as standalone tokens', () => {
    assert.equal(
        decorateText('nice :) <3', { nick: 'x' }),
        'nice <span class="emote" title=":)">🙂</span> <span class="emote" title="&lt;3">❤️</span>',
    );
    assert.equal(decorateText(':Dir', { nick: 'x' }), ':Dir');
});

test('decorateText escapes HTML', () => {
    assert.equal(decorateText('<script>', { nick: 'x' }), '&lt;script&gt;');
});

test('formatDayLabel returns today/yesterday labels', () => {
    const now = new Date('2026-10-24T12:00:00').getTime();
    assert.equal(formatDayLabel(new Date('2026-10-24T08:00:00').getTime(), { now }), 'Today');
    assert.equal(formatDayLabel(new Date('2026-10-23T23:59:00').getTime(), { now, yesterday: 'Gestern' }), 'Gestern');
});

test('nickHue is stable and case-insensitive', () => {
    assert.equal(nickHue('Alice'), nickHue('alice'));
    assert.ok(nickHue('someone') >= 0 && nickHue('someone') < 360);
});

test('normalizeHighlightWords trims, splits, de-duplicates and limits', () => {
    assert.deepEqual(normalizeHighlightWords(' Kirk , kirk,\nEnterprise-E,,'), ['Kirk', 'Enterprise-E']);
    assert.deepEqual(normalizeHighlightWords(['a', ' ', null, 'A']), ['a']);
    assert.equal(normalizeHighlightWords(Array.from({ length: 30 }, (_, i) => `w${i}`)).length, 20);
    assert.equal(normalizeHighlightWords(['x'.repeat(80)])[0].length, 50);
    assert.deepEqual(normalizeHighlightWords(undefined), []);
});

test('isHighlighted matches the nick and whole highlight words case-insensitively', () => {
    const words = ['Kapitän', 'Enterprise', 'Warp 9'];

    assert.equal(isHighlighted('hey alice', 'alice', words), true);
    assert.equal(isHighlighted('Der kapitän kommt', 'alice', words), true);
    assert.equal(isHighlighted('Auf WARP 9 gehen', 'alice', words), true);
    assert.equal(isHighlighted('die enterprise.', 'alice', words), true);
    assert.equal(isHighlighted('\x02Enterprise\x02 voraus', 'alice', words), true);

    assert.equal(isHighlighted('Enterprises', 'alice', words), false);
    assert.equal(isHighlighted('NCC-Enterprise_2', 'alice', words), false);
    assert.equal(isHighlighted('nichts', 'alice', words), false);
    assert.equal(isHighlighted('Enterprise', 'alice', []), false);
    assert.equal(isHighlighted('', 'alice', words), false);
});

test('isHighlighted treats regex characters in words literally', () => {
    assert.equal(isHighlighted('a.b', 'x', ['a.b']), true);
    assert.equal(isHighlighted('axb', 'x2', ['a.b']), false);
    assert.equal(isHighlighted('(USS)', 'x', ['(USS)']), true);
});

test('decorateText marks highlight words like an own mention and prefers the longest word', () => {
    assert.equal(
        decorateText('Die Enterprise-E fliegt', { nick: 'alice', highlightWords: ['Enterprise', 'Enterprise-E'] }),
        'Die <span class="mention mention--me mention--word">Enterprise-E</span> fliegt',
    );
    assert.equal(
        decorateText('<Kirk>', { nick: 'x', highlightWords: ['Kirk'] }),
        '&lt;<span class="mention mention--me mention--word">Kirk</span>&gt;',
    );
});
