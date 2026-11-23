import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidResources, loadEdition, runtimeEdition, VERSION_PATTERN, versionCode } from '../scripts/edition.mjs';

const bundledEdition = fileURLToPath(new URL('../edition', import.meta.url));
const icon = path.join(bundledEdition, 'icon.png');

function editionDir(edition, extraFiles = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'starchat-mobile-edition-'));
    copyFileSync(icon, path.join(dir, 'icon.png'));
    for (const [name, content] of Object.entries(extraFiles)) writeFileSync(path.join(dir, name), content);
    writeFileSync(path.join(dir, 'edition.json'), JSON.stringify(edition));
    return dir;
}

const minimal = { appName: 'Example Chat', appId: 'org.example.chat', icon: 'icon.png', chat: {} };

test('the bundled StarChat edition is valid and has no preset network', () => {
    const { edition, files } = loadEdition(bundledEdition);
    assert.equal(edition.appId, 'net.getstarchat.app');
    assert.ok(files['adaptiveIcon.foreground'].endsWith('icon-foreground.xml'));
    const runtime = runtimeEdition(edition, '0.1.0');
    assert.equal(runtime.chat.primaryServer, '');
    assert.equal(runtime.chat.serverList, 'default');
    // Push only when a google-services.json lies in the folder (not in git)
    assert.equal(runtime.push, Boolean(files['push.googleServices']));
    assert.equal(runtime.pushGateway, files['push.googleServices'] ? 'https://push.getstarchat.net' : '');
});

test('invalid editions name the problem', () => {
    assert.throws(() => loadEdition(editionDir({ ...minimal, appId: 'chat' })), /appId/);
    assert.throws(() => loadEdition(editionDir({ ...minimal, executableName: 'x' })), /additional properties/);
    assert.throws(() => loadEdition(editionDir({ ...minimal, icon: '../icon.png' })), /outside the edition folder/);
});

test('google-services.json must belong to the app id', () => {
    const services = (packageName) => JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: packageName } } }] });
    const withPush = { ...minimal, push: { googleServices: 'google-services.json' } };
    assert.throws(
        () => loadEdition(editionDir(withPush, { 'google-services.json': services('net.other.app') })),
        /no Android app with the package name org\.example\.chat \(found: net\.other\.app\)/,
    );
    const { edition } = loadEdition(editionDir(withPush, { 'google-services.json': services('org.example.chat') }));
    assert.equal(runtimeEdition(edition, '1.0.0').push, true);
});

test('the push gateway counts only together with the Firebase file', () => {
    const services = JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: 'org.example.chat' } } }] });
    const withGateway = { ...minimal, push: { gateway: 'https://push.example.org/' } };

    const { edition } = loadEdition(editionDir(withGateway, { 'google-services.json': services }));
    assert.equal(runtimeEdition(edition, '1.0.0').push, true);
    assert.equal(runtimeEdition(edition, '1.0.0').pushGateway, 'https://push.example.org');

    const without = loadEdition(editionDir(withGateway)).edition;
    assert.equal(runtimeEdition(without, '1.0.0').push, false);
    assert.equal(runtimeEdition(without, '1.0.0').pushGateway, '');
    assert.throws(() => loadEdition(editionDir({ ...minimal, push: { gateway: 'http://push.example.org' } })), /gateway/);
});

test('the development build gets its own id and name, google-services.json must know it', () => {
    const services = (...packageNames) => JSON.stringify({
        client: packageNames.map((name) => ({ client_info: { android_client_info: { package_name: name } } })),
    });
    const { edition } = loadEdition(editionDir(minimal), { dev: true });
    assert.equal(edition.appId, 'org.example.chat.dev');
    assert.equal(edition.appName, 'Example Chat Dev');

    assert.equal(loadEdition(editionDir({ ...minimal, devAppId: 'org.example.dev' }), { dev: true }).edition.appId, 'org.example.dev');
    assert.equal(loadEdition(editionDir({ ...minimal, devAppId: 'org.example.dev' })).edition.appId, 'org.example.chat');

    const long = loadEdition(editionDir({ ...minimal, appName: 'A'.repeat(30) }), { dev: true }).edition;
    assert.equal(long.appName.length, 30);

    assert.throws(
        () => loadEdition(editionDir(minimal, { 'google-services.json': services('org.example.chat') }), { dev: true }),
        /package name org\.example\.chat\.dev/,
    );
    const both = loadEdition(editionDir(minimal, { 'google-services.json': services('org.example.chat', 'org.example.chat.dev') }), { dev: true });
    assert.equal(runtimeEdition(both.edition, '0.0.0-dev.1').push, true);
});

test('a google-services.json in the edition folder is used without naming it', () => {
    const services = JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: 'org.example.chat' } } }] });
    const { edition, files } = loadEdition(editionDir(minimal, { 'google-services.json': services }));
    assert.ok(files['push.googleServices'].endsWith('google-services.json'));
    assert.equal(runtimeEdition(edition, '1.0.0').push, true);

    const without = loadEdition(editionDir(minimal));
    assert.equal(without.files['push.googleServices'], undefined);
    assert.equal(runtimeEdition(without.edition, '1.0.0').push, false);
});

test('version codes grow with every release', () => {
    assert.equal(versionCode('0.1.2'), 102);
    assert.equal(versionCode('1.2.3'), 10203);
    assert.ok(versionCode('1.10.0') > versionCode('1.9.99'));
    assert.throws(() => versionCode('1.100.0'), /below 100/);
    // Development builds count with the build number
    assert.equal(versionCode('0.0.0-dev.57'), 57);
    assert.ok(VERSION_PATTERN.test('0.0.0-dev.57'));
    assert.ok(VERSION_PATTERN.test('1.2.3'));
    assert.ok(!VERSION_PATTERN.test('1.2'));
    assert.ok(!VERSION_PATTERN.test('1.2.3-beta'));
});

test('android resources carry name, colours and icons of the edition', () => {
    const resources = androidResources(
        { ...minimal, appName: 'Tom & Jerry\'s', adaptiveIcon: { foreground: 'fg.png', background: '#123456' } },
        { icon: '/edition/icon.png', 'adaptiveIcon.foreground': '/edition/fg.png' },
    );
    assert.match(resources['values/edition.xml'], /<string name="app_name">Tom &amp; Jerry\\'s<\/string>/);
    assert.match(resources['values/edition.xml'], /<color name="ic_launcher_background">#123456<\/color>/);
    assert.deepEqual(resources['drawable-nodpi/ic_launcher_foreground.png'], { copy: '/edition/fg.png' });
    assert.match(resources['mipmap-anydpi-v26/ic_launcher.xml'], /@drawable\/ic_launcher_foreground/);
    assert.deepEqual(resources['mipmap-nodpi/ic_launcher.png'], { copy: '/edition/icon.png' });

    const plain = androidResources(minimal, { icon: '/edition/icon.png' });
    assert.match(plain['drawable/ic_launcher_foreground.xml'], /<inset .*@drawable\/edition_icon/);
    assert.match(plain['values/edition.xml'], /<color name="splash_background">#ffffff<\/color>/);
});
