'use strict';

/**
 * Background updates: the app starts without waiting for the update server. Updates are
 * looked for shortly after the start and then every hour, downloaded silently and
 * offered to the user once they are ready ("restart now / later"). A postponed update
 * is installed on the next regular quit.
 *
 * Free of Electron imports so the scheduling can be unit-tested with fake timers.
 */

const INITIAL_DELAY_MS = 15 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {{
 *   checkForUpdates: () => Promise<unknown>,
 *   onReady?: (update: { version: string }) => void,
 *   logger?: { info: Function, warn: Function },
 *   initialDelayMs?: number,
 *   intervalMs?: number,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 * }} options
 */
function createUpdateScheduler({
    checkForUpdates,
    onReady = () => {},
    logger = console,
    initialDelayMs = INITIAL_DELAY_MS,
    intervalMs = INTERVAL_MS,
    timers = globalThis,
}) {
    let initialTimer = null;
    let intervalTimer = null;
    let checking = false;
    let pending = null;

    async function check() {
        // A check (and its download) still running: never start a second one
        if (checking) return false;
        checking = true;
        try {
            await checkForUpdates();
            return true;
        } catch (error) {
            // offline, server down …: try again at the next interval
            logger.warn('Background update check failed:', error?.message || error);
            return false;
        } finally {
            checking = false;
        }
    }

    return {
        start() {
            if (initialTimer || intervalTimer) return;
            initialTimer = timers.setTimeout(() => {
                initialTimer = null;
                check();
                intervalTimer = timers.setInterval(check, intervalMs);
            }, initialDelayMs);
        },

        stop() {
            if (initialTimer) timers.clearTimeout(initialTimer);
            if (intervalTimer) timers.clearInterval(intervalTimer);
            initialTimer = null;
            intervalTimer = null;
        },

        check,

        /** The updater finished downloading: remember it and tell the UI. */
        markDownloaded(info) {
            const version = String(info?.version || '');
            if (pending?.version === version) return;
            pending = { version };
            logger.info(`Update ${version} downloaded, offering a restart`);
            onReady(pending);
        },

        pendingUpdate() {
            return pending;
        },
    };
}

module.exports = { createUpdateScheduler, INITIAL_DELAY_MS, INTERVAL_MS };
