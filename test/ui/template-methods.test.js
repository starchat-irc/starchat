/**
 * Every method and property the templates use must exist on the component, unless it
 * sits inside a part that is only rendered with a feature or module
 * (<template x-if="hasFeature('…')"> or x-if="hasModule('…')").
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createPlainStore } from '../../src/core/store.js';
import { createTranslator } from '../../src/i18n/index.js';
import { renderTemplate } from '../../src/ui/templates.js';
import { createChatComponent } from '../../src/ui/component.js';
import { createChannelManagementState } from '../../src/ui/mixins/channel-management.js';
import { installBrowserStubs } from './chat-harness.js';
import { emojiPicker } from '../../src/ui/emoji-picker.js';
import { templates } from '../../src/ui/templates.js';

const IGNORED = new Set(('true false null undefined if else return const let var new typeof instanceof in of this '
    + 'window document Math Date Number String Object Array JSON Boolean parseInt parseFloat encodeURIComponent '
    + 'console event setTimeout clearTimeout navigator location Intl isNaN await async function').split(' '));

/**
 * Drops <template x-if="hasFeature('…')">…</template> blocks (also hasModule, also with
 * "&& more conditions"), nested templates included.
 */
export function withoutGatedParts(html) {
    const opener = /<template\s+x-if="(?:hasFeature|hasModule)\('[\w-]+'\)(?:\s*&&[^"]*)?"\s*>/g;
    let result = html;
    let match;
    while ((match = opener.exec(result))) {
        const start = match.index;
        let depth = 1;
        const tag = /<template\b|<\/template>/g;
        tag.lastIndex = start + match[0].length;
        let end = -1;
        let next;
        while ((next = tag.exec(result))) {
            depth += next[0] === '</template>' ? -1 : 1;
            if (depth === 0) {
                end = next.index + next[0].length;
                break;
            }
        }
        if (end === -1) throw new Error('unclosed gated template');
        result = result.slice(0, start) + result.slice(end);
        opener.lastIndex = start;
    }
    return result;
}

/** Identifiers used at the top level of Alpine expressions, with how often they appear. */
export function usedIdentifiers(html) {
    const attributes = [...html.matchAll(/\s(x-[\w.:-]+|:[\w.-]+|@[\w.:-]+)="([^"]*)"/g)]
        .filter(match => !/^x-(ref|transition|cloak|ignore)\b/.test(match[1]));
    const locals = new Set();
    // x-data opens its own scope: a registered component ("emojiPicker()") or an object
    // whose keys are local names ("{ loading: false }").
    for (const [, name, value] of attributes) {
        if (name !== 'x-data') continue;
        for (const key of value.matchAll(/([A-Za-z_$][\w$]*)\s*(?::|\()/g)) locals.add(key[1]);
    }
    const expressions = attributes.filter(([, name]) => name !== 'x-data').map(match => match[2]);
    for (const expression of expressions) {
        // x-for="item in …", "(item, index) in …", "[key, value] in …"
        const loop = expression.match(/^\s*[([]?\s*([\w$,\s]+?)\s*[)\]]?\s+(?:in|of)\s/);
        if (loop) {
            loop[1].split(',').map(name => name.trim()).filter(Boolean).forEach(name => locals.add(name));
        }
        // Arrow function parameters: (a, b) => …  or  a => …
        for (const arrow of expression.matchAll(/\(?([\w$,\s]*)\)?\s*=>/g)) {
            arrow[1].split(',').map(name => name.trim()).filter(Boolean).forEach(name => locals.add(name));
        }
    }
    const used = new Map();
    for (const expression of expressions) {
        const code = expression.replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "''");
        for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_][\w$]*)\b(?!\s*:(?!:))/g)) {
            const name = match[1];
            if (locals.has(name) || IGNORED.has(name)) continue;
            used.set(name, (used.get(name) || 0) + 1);
        }
    }
    return used;
}

beforeEach(() => {
    installBrowserStubs();
});

test('the templates only use what the component has, or gate it', () => {
    const t = createTranslator({ locale: 'en' });
    const component = createChatComponent({
        connection: { server: { id: 'test' }, hasFeature: () => false, websocketUrl: 'wss://irc.example.org' },
        t,
        stores: {
            messages: createPlainStore(),
            users: createPlainStore(),
            channelTopics: createPlainStore(),
            channelManagement: createPlainStore(createChannelManagementState()),
        },
    });
    // Names of the picker's own x-data scope count as known
    const keys = new Set([...Object.getOwnPropertyNames(component), ...Object.keys(emojiPicker(t))]);
    const html = withoutGatedParts(renderTemplate('chat', t));
    const missing = [...usedIdentifiers(html).keys()].filter(name => !keys.has(name)).sort();
    // Missing name -> templates that use it, so the failure says where to gate
    const where = Object.fromEntries(missing.map(name => [
        name,
        Object.keys(templates).filter(file => new RegExp(`\\b${name}\\b`).test(templates[file])).join(' '),
    ]));
    assert.deepEqual(where, {});
});
