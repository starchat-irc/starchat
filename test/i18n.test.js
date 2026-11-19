import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTranslator, messages, resolveLanguage } from '../src/i18n/index.js';

test('German and English have the same keys', () => {
    assert.deepEqual(Object.keys(messages.de).sort(), Object.keys(messages.en).sort());
});

test('placeholders match between the languages', () => {
    const placeholders = (text) => [...String(text).matchAll(/:([a-z][a-z_]*)/gi)].map((m) => m[1]).sort();
    for (const key of Object.keys(messages.en)) {
        assert.deepEqual(placeholders(messages.de[key]), placeholders(messages.en[key]), key);
    }
});

test('texts name no platform, the app name comes from :app', () => {
    for (const [language, texts] of Object.entries(messages)) {
        for (const [key, text] of Object.entries(texts)) {
            assert.doesNotMatch(text, /ST-City|st-city\.net/i, `${language}.${key}`);
        }
    }
});

test('the locale picks the language, unknown ones fall back to English', () => {
    assert.equal(resolveLanguage('de-DE'), 'de');
    assert.equal(resolveLanguage('de_AT'), 'de');
    assert.equal(resolveLanguage('EN'), 'en');
    assert.equal(resolveLanguage('fr-FR'), 'en');
    assert.equal(resolveLanguage(undefined), 'en');
    assert.equal(createTranslator({ locale: 'de-DE' })('close'), 'Schließen');
    assert.equal(createTranslator({ locale: 'fr' })('close'), 'Close');
});

test('params replace every occurrence, longer names first', () => {
    const t = createTranslator({ overrides: { x: ':count of :countTotal, again :count' } });
    assert.equal(t('x', { count: 1, countTotal: 9 }), '1 of 9, again 1');
});

test(':app is the app name', () => {
    assert.equal(createTranslator({ locale: 'en' })('connections_new_home'), 'StarChat');
    assert.equal(createTranslator({ locale: 'en', appName: 'Example Chat' })('connections_new_home'), 'Example Chat');
});

test('overrides win, unknown keys come back as the key', () => {
    const t = createTranslator({ locale: 'de', overrides: { close: 'Zu' } });
    assert.equal(t('close'), 'Zu');
    assert.equal(t('does_not_exist'), 'does_not_exist');
});

test('a key missing in German falls back to English', () => {
    const original = messages.de.close;
    delete messages.de.close;
    try {
        assert.equal(createTranslator({ locale: 'de' })('close'), 'Close');
    } finally {
        messages.de.close = original;
    }
});
