import { test } from 'node:test';
import assert from 'node:assert/strict';
import errorReport from '../error-report.js';

const { createErrorLog, scrub } = errorReport;
const silent = { warn() {} };

/** In-memory stand-in for the sync fs functions the log uses. */
function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
        files,
        existsSync: path => files.has(path),
        readFileSync: path => files.get(path),
        writeFileSync: (path, content) => files.set(path, content),
        mkdirSync() {},
    };
}

function setup(options = {}) {
    const fs = options.fs || memoryFs();
    let time = Date.parse('2026-11-09T12:00:00Z');
    const log = createErrorLog({
        filePath: '/data/logs/renderer-errors.log',
        fs,
        dirname: () => '/data/logs',
        now: () => new Date(time),
        logger: silent,
        ...options,
    });
    return { log, fs, advance: (ms) => { time += ms; } };
}

test('records an error and keeps it in the log file', () => {
    const { log, fs } = setup();

    assert.equal(log.record({ kind: 'error', source: 'chat', message: 'boom', filename: 'app://chat/main.js', lineno: 12, colno: 4, stack: 'Error: boom\n  at x' }), true);

    assert.equal(log.count(), 1);
    assert.deepEqual(log.entries()[0], {
        time: '2026-11-09T12:00:00.000Z',
        kind: 'error',
        source: 'chat',
        message: 'boom',
        location: 'app://chat/main.js:12:4',
        stack: 'Error: boom\n  at x',
    });
    assert.match(fs.files.get('/data/logs/renderer-errors.log'), /"message":"boom"/);
});

test('loads earlier entries on start and skips torn lines', () => {
    const fs = memoryFs({
        '/data/logs/renderer-errors.log': '{"time":"t","kind":"error","source":"shell","message":"old","location":"","stack":""}\n{"time":"t2","mess\n',
    });
    const { log } = setup({ fs });

    assert.equal(log.count(), 1);
    assert.equal(log.entries()[0].message, 'old');
});

test('rejects payloads without a message and unknown kinds/sources fall back', () => {
    const { log } = setup();

    assert.equal(log.record(null), false);
    assert.equal(log.record({ message: '   ' }), false);
    assert.equal(log.record({ message: 'x', kind: 'evil', source: 'remote', lineno: '3' }), true);
    assert.deepEqual(
        { kind: log.entries()[0].kind, source: log.entries()[0].source, location: log.entries()[0].location },
        { kind: 'error', source: 'shell', location: '' },
    );
});

test('tokens, passwords and JWTs never reach the log', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJrbGFhcyJ9.c2lnbmF0dXJl';
    const { log } = setup();

    log.record({
        message: `fetch failed: https://st-city.test/app?channel=lobby&token=${jwt} Bearer abc.def`,
        filename: 'https://st-city.test/embed?token=secret123#x',
        stack: `at load (https://st-city.test/x?password=hunter2&y=1)`,
    });

    const entry = log.entries()[0];
    const all = JSON.stringify(entry);
    assert.ok(!all.includes(jwt));
    assert.ok(!all.includes('secret123'));
    assert.ok(!all.includes('hunter2'));
    assert.ok(!all.includes('abc.def'));
    assert.match(entry.message, /channel=lobby&token=\[redacted\]/);
    assert.match(entry.stack, /password=\[redacted\]&y=1/);
});

test('long messages and stacks are cut', () => {
    assert.equal(scrub('x'.repeat(20), 5), 'xxxxx…');
    const { log } = setup();
    log.record({ message: 'm'.repeat(5000), stack: 's'.repeat(10000) });
    assert.ok(log.entries()[0].message.length <= 1001);
    assert.ok(log.entries()[0].stack.length <= 4001);
});

test('the same error in a row is counted instead of repeated', () => {
    const { log, advance } = setup();

    log.record({ message: 'loop', filename: 'a.js', lineno: 1 });
    advance(1000);
    log.record({ message: 'loop', filename: 'a.js', lineno: 1 });
    log.record({ message: 'other' });

    assert.equal(log.count(), 2);
    assert.equal(log.entries()[0].repeated, 2);
    assert.equal(log.entries()[0].time, '2026-11-09T12:00:01.000Z');
    assert.match(log.buildReport(), /\(×2\): loop/);
});

test('an error flood is capped per minute', () => {
    const { log, advance } = setup({ rateLimit: 3 });

    const stored = [1, 2, 3, 4, 5].map(n => log.record({ message: `e${n}` }));
    assert.deepEqual(stored, [true, true, true, false, false]);

    advance(60 * 1000);
    assert.equal(log.record({ message: 'later' }), true);
    assert.equal(log.count(), 4);
});

test('keeps only the newest entries', () => {
    const { log } = setup({ maxEntries: 3, rateLimit: 100 });
    ['a', 'b', 'c', 'd', 'e'].forEach(message => log.record({ message }));
    assert.deepEqual(log.entries().map(entry => entry.message), ['c', 'd', 'e']);
});

test('the report lists app info and every entry, clear empties it', () => {
    const { log, fs } = setup();
    log.record({ kind: 'unhandledrejection', source: 'chat', message: 'nope', stack: 'Error: nope\n    at a (b.js:1:2)' });

    const report = log.buildReport({ version: '0.1.15', electron: '33.0.0', platform: 'win32', arch: 'x64', os: '10.0.26200' });
    assert.match(report, /Version: 0\.1\.15 · Electron 33\.0\.0 · win32 x64 10\.0\.26200/);
    assert.match(report, /Entries: 1/);
    assert.match(report, /chat\/unhandledrejection: nope/);
    assert.match(report, /\n {4}at a \(b\.js:1:2\)/);

    log.clear();
    assert.equal(log.count(), 0);
    assert.equal(fs.files.get('/data/logs/renderer-errors.log'), '');
    assert.match(log.buildReport(), /No errors logged\./);
});

test('a broken disk never throws into the app', () => {
    const fs = memoryFs();
    fs.writeFileSync = () => { throw new Error('EACCES'); };
    fs.existsSync = () => { throw new Error('EIO'); };
    const { log } = setup({ fs });

    assert.equal(log.count(), 0);
    assert.equal(log.record({ message: 'still fine' }), true);
    assert.equal(log.count(), 1);
});

test('every local module main.js requires is shipped with the packaged app', async () => {
    const { readFile } = await import('node:fs/promises');
    const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    // package.json is always packed by electron-builder
    const required = [...main.matchAll(/require\('\.\/([^']+?)(?:\.js)?'\)/g)]
        .filter(match => !match[1].endsWith('.json'))
        .map(match => `${match[1]}.js`);

    assert.ok(required.includes('error-report.js'));
    for (const file of required) {
        assert.ok(pkg.build.files.includes(file), `${file} is missing in build.files`);
    }
});
