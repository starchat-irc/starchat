/**
 * Start script of the edition (chat.startScript in edition.json), used by the chat pages of
 * the desktop and the mobile app. It runs before mountChat(), once per page load and
 * connection, and can for example take over settings an older app of the edition stored
 * under other keys.
 *
 * A failing script or one that takes too long is logged, the chat starts anyway.
 */

export const START_SCRIPT_TIMEOUT_MS = 5000;

/**
 * What the start script gets.
 *
 * @param {Object} profile the profile from init-chat-config
 * @param {Object} options mountChat() options from mountOptionsFor()
 * @param {Object} edition generated/edition.json
 * @param {'desktop'|'mobile'} shell
 * @return {{ shell: string, appName: string, version: string, storageScope: string, primary: boolean }}
 */
export function startScriptContext(profile, options, edition, shell) {
    return {
        shell,
        appName: String(edition.appName || ''),
        version: String(edition.version || ''),
        storageScope: String(options.storageScope || ''),
        primary: !profile.isExternalServer,
    };
}

/**
 * @param {unknown} script default export of generated/edition-start.mjs, null without one
 * @param {Object} context from startScriptContext()
 * @param {{ timeoutMs?: number, log?: { error: Function } }} [options]
 * @return {Promise<void>} never rejects
 */
export async function runStartScript(script, context, { timeoutMs = START_SCRIPT_TIMEOUT_MS, log = console } = {}) {
    if (script === null || script === undefined) return;
    if (typeof script !== 'function') {
        log.error('[starchat] The start script of the edition does not export a function.');
        return;
    }
    let timer;
    try {
        await Promise.race([
            Promise.resolve().then(() => script(Object.freeze({ ...context }))),
            new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`took longer than ${timeoutMs} ms`)), timeoutMs);
            }),
        ]);
    } catch (error) {
        log.error('[starchat] The start script of the edition failed:', error);
    } finally {
        clearTimeout(timer);
    }
}

/** Content of generated/edition-start.mjs when the edition has no start script. */
export const NO_START_SCRIPT = '// no start script of the edition\nexport default null;\n';
