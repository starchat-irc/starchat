/**
 * config.json of the hostable web page: which values reach mountChat().
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pushWorkerUrl, readWebConfig } from '../../web/config.js';

test('known options with the right type are passed on, everything else is dropped', () => {
    const { options } = readWebConfig({
        primaryServer: ' irc.example.org ',
        defaultChannel: '#lobby',
        serverList: 'https://example.org/servers.json',
        theme: 'dark',
        locale: ['de-DE', 'en'],
        appName: 'MyNet Chat',
        overrides: { home: 'Start', broken: 5 },
        bearer: 'function () {}',
        onHostMessage: 'x',
        nickname: 'auto',
    });

    assert.deepEqual(options, {
        primaryServer: 'irc.example.org',
        defaultChannel: '#lobby',
        appName: 'MyNet Chat',
        serverList: 'https://example.org/servers.json',
        locale: ['de-DE', 'en'],
        theme: 'dark',
        overrides: { home: 'Start' },
    });
});

test('server lists: default, false or an https URL', () => {
    assert.equal(readWebConfig({ serverList: false }).options.serverList, false);
    assert.equal(readWebConfig({ serverList: 'default' }).options.serverList, 'default');
    assert.equal(readWebConfig({ serverList: 'http://example.org/list.json' }).options.serverList, undefined);
    assert.equal(readWebConfig({ theme: 'pink' }).options.theme, undefined);
});

test('the address may pick server, language and theme unless switched off', () => {
    const search = '?server=irc.other.net&lang=de&theme=light';
    assert.deepEqual(readWebConfig({ primaryServer: 'irc.example.org' }, search).options,
        { primaryServer: 'irc.other.net', locale: 'de', theme: 'light' });
    assert.deepEqual(readWebConfig({ primaryServer: 'irc.example.org', urlParameters: false }, search).options,
        { primaryServer: 'irc.example.org' });
    assert.equal(readWebConfig({ primaryServer: 'a.org' }, '?server=evil/path').options.primaryServer, 'a.org');
});

test('notice, https links, title, modules and push', () => {
    const config = readWebConfig({
        appName: 'MyNet',
        notice: 'Be nice.',
        links: [{ label: 'Imprint', url: 'https://example.org/imprint' }, { label: 'Bad', url: 'javascript:alert(1)' }, { url: 'https://x.org' }],
        modules: ['profiles', 3, 'voice'],
        push: false,
    });
    assert.equal(config.title, 'MyNet');
    assert.equal(config.notice, 'Be nice.');
    assert.deepEqual(config.links, [{ label: 'Imprint', url: 'https://example.org/imprint' }]);
    assert.deepEqual(config.modules, ['profiles', 'voice']);
    assert.equal(config.push, false);

    const empty = readWebConfig(null);
    assert.equal(empty.title, 'StarChat');
    assert.equal(empty.modules, null, 'all modules');
    assert.equal(empty.push, true);
});

test('the push worker lives next to the page and opens it', () => {
    assert.equal(pushWorkerUrl({ appName: 'MyNet' }, '/chat/'), '/chat/push-sw.js?name=MyNet&chat=%2Fchat%2F&icon=%2Fchat%2Ffavicon.svg');
    assert.equal(pushWorkerUrl({}, '/chat/index.html'), '/chat/push-sw.js?name=StarChat&chat=%2Fchat%2F&icon=%2Fchat%2Ffavicon.svg');
    assert.equal(pushWorkerUrl({}, '/'), '/push-sw.js?name=StarChat&chat=%2F&icon=%2Ffavicon.svg');
});
