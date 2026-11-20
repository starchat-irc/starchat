import { test } from 'node:test';
import assert from 'node:assert/strict';
import updates from '../updates.js';

const { createUpdateScheduler } = updates;
const silent = { info() {}, warn() {} };

/** Minimal deterministic timers: advance() runs everything that is due. */
function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const jobs = new Map();
    const add = (fn, delay, repeat) => {
        const id = nextId++;
        jobs.set(id, { fn, at: now + delay, delay, repeat });
        return id;
    };
    return {
        setTimeout: (fn, delay) => add(fn, delay, false),
        setInterval: (fn, delay) => add(fn, delay, true),
        clearTimeout: (id) => jobs.delete(id),
        clearInterval: (id) => jobs.delete(id),
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, job] = due;
                now = job.at;
                if (job.repeat) job.at += job.delay;
                else jobs.delete(id);
                job.fn();
            }
            now = target;
        },
    };
}

function setup(checkForUpdates = async () => {}) {
    const timers = fakeTimers();
    const ready = [];
    const calls = { count: 0 };
    const scheduler = createUpdateScheduler({
        checkForUpdates: () => { calls.count++; return checkForUpdates(); },
        onReady: (update) => ready.push(update),
        logger: silent,
        initialDelayMs: 1000,
        intervalMs: 10000,
        timers,
    });
    return { scheduler, ready, calls, timers };
}

test('the first check runs shortly after start, then every interval', async () => {
    const { scheduler, calls, timers } = setup();
    scheduler.start();
    assert.equal(calls.count, 0, 'no check during the start itself');

    timers.advance(1000);
    assert.equal(calls.count, 1);
    await Promise.resolve();

    timers.advance(10000);
    assert.equal(calls.count, 2);
    await Promise.resolve();
    timers.advance(10000);
    assert.equal(calls.count, 3);
    scheduler.stop();
});

test('start is idempotent and stop ends the schedule', async () => {
    const { scheduler, calls, timers } = setup();
    scheduler.start();
    scheduler.start();
    timers.advance(1000);
    assert.equal(calls.count, 1);
    await Promise.resolve();

    scheduler.stop();
    timers.advance(50000);
    assert.equal(calls.count, 1);
});

test('a running check is never started twice', async () => {
    let release;
    const { scheduler, calls } = setup(() => new Promise((resolve) => { release = resolve; }));

    const first = scheduler.check();
    assert.equal(await scheduler.check(), false);
    assert.equal(calls.count, 1);
    release();
    assert.equal(await first, true);

    // once finished, the next check may run again
    const second = scheduler.check();
    assert.equal(calls.count, 2);
    release();
    assert.equal(await second, true);
});

test('a failing check is swallowed so the next interval tries again', async () => {
    const { scheduler } = setup(async () => { throw new Error('offline'); });
    assert.equal(await scheduler.check(), false);
    assert.equal(await scheduler.check(), false);
});

test('a downloaded update is offered once per version', () => {
    const { scheduler, ready } = setup();
    assert.equal(scheduler.pendingUpdate(), null);

    scheduler.markDownloaded({ version: '0.1.15' });
    scheduler.markDownloaded({ version: '0.1.15' });
    assert.deepEqual(ready, [{ version: '0.1.15' }]);
    assert.deepEqual(scheduler.pendingUpdate(), { version: '0.1.15' });

    scheduler.markDownloaded({ version: '0.1.16' });
    assert.deepEqual(ready.at(-1), { version: '0.1.16' });
});
