import { test } from 'vitest';
import assert from 'node:assert/strict';
import { renderTemplate, templates } from '../../src/ui/templates.js';
import { createTranslator, messages } from '../../src/i18n/index.js';

const t = createTranslator({ locale: 'en' });

/** Keys used as "{{ t('key') }}" or in Alpine expressions as t('key'). */
function usedKeys(html) {
    return new Set([...html.matchAll(/\bt\('([a-z0-9_]+)'\s*[,)]/g)].map((match) => match[1]));
}

test('all templates are bundled', () => {
    assert.ok(Object.keys(templates).length >= 20);
    assert.ok(templates.chat.includes('x-data="chatComponent()"'));
});

test('the chat template includes every other template', () => {
    const html = renderTemplate('chat', t);
    const included = new Set(['chat']);
    const collect = (name) => {
        for (const [, partial] of templates[name].matchAll(/\{\{> ([a-z0-9-]+) \}\}/g)) {
            if (!included.has(partial)) {
                included.add(partial);
                collect(partial);
            }
        }
    };
    collect('chat');
    assert.deepEqual([...included].sort(), Object.keys(templates).sort());
    assert.doesNotMatch(html, /\{\{/, 'no marker is left after rendering');
});

test('no Blade syntax is left in the templates', () => {
    for (const [name, html] of Object.entries(templates)) {
        assert.doesNotMatch(html, /@(if|foreach|endforeach|php|json|js|include|csrf|vite|lang)\b|__\(|\{\{\s*\$|\{!!/, name);
    }
});

test('every text key used in a template exists in all languages', () => {
    for (const [name, html] of Object.entries(templates)) {
        for (const key of usedKeys(html)) {
            for (const [language, texts] of Object.entries(messages)) {
                assert.ok(Object.hasOwn(texts, key), `${name}: "${key}" is missing in ${language}.json`);
            }
        }
    }
});

test('rendered texts are escaped', () => {
    const translate = createTranslator({ overrides: { close: '<b>Close & go</b>' } });
    const html = renderTemplate('x', translate, { x: "<p>{{ t('close') }}</p>" });
    assert.equal(html, '<p>&lt;b&gt;Close &amp; go&lt;/b&gt;</p>');
});

test('Alpine bindings with t() stay for the runtime', () => {
    const html = renderTemplate('x', t, { x: `<span x-text="t('loading')"></span>` });
    assert.equal(html, `<span x-text="t('loading')"></span>`);
});

test('partials are inserted, unknown ones and loops fail', () => {
    const source = {
        page: '<main>{{> part }}</main>',
        part: "<p>{{ t('close') }}</p>",
        broken: '{{> nope }}',
        a: '{{> b }}',
        b: '{{> a }}',
    };
    assert.equal(renderTemplate('page', t, source), '<main><p>Close</p></main>');
    assert.throws(() => renderTemplate('broken', t, source), /Unknown template "nope" \(included from broken\)/);
    assert.throws(() => renderTemplate('a', t, source), /loop: a > b > a/);
});

const VOID_ELEMENTS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Returns the first nesting error of an HTML fragment, or null. Attribute values may hold
 * ">" (Alpine expressions), so tags are matched with quoted attributes in mind.
 */
function nestingError(html) {
    const stack = [];
    const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    for (const [whole, closing, rawName, , selfClosing] of html.matchAll(tags)) {
        if (whole.startsWith('<!--')) continue;
        const name = rawName.toLowerCase();
        if (VOID_ELEMENTS.has(name) || selfClosing) continue;
        if (!closing) {
            stack.push(name);
        } else if (stack.at(-1) !== name) {
            return `</${name}> closes <${stack.at(-1) ?? 'nothing'}>`;
        } else {
            stack.pop();
        }
    }
    return stack.length ? `<${stack.at(-1)}> is never closed` : null;
}

test('every template closes its elements in the right order', () => {
    for (const [name, html] of Object.entries(templates)) {
        assert.equal(nestingError(html), null, name);
    }
    assert.equal(nestingError('<div><template x-if="a"><div></template></div>'), '</template> closes <div>');
});
