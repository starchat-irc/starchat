/**
 * Parts of the chat an embedding page can switch off (mountChat option "layout").
 *
 * 'full' shows everything. 'headless' leaves only the messages of the current channel
 * and the input line, for a chat box inside a game or another app. An object switches
 * single parts off and keeps the rest.
 */

/**
 * @typedef {Object} ChatLayout
 * @property {boolean} header       Channel name, topic, buttons and message search above the messages.
 * @property {boolean} channelList  Icon rail and channel list (and with them the friends and upload views).
 * @property {boolean} userList     Nick list of the channel.
 * @property {boolean} joinPart     Join and part lines in the messages.
 * @property {boolean} logout       Logout button of the input line.
 * @property {boolean} shortcuts    Keyboard shortcuts on the whole page (Ctrl+P, Ctrl+F, Alt+Up/Down, ?).
 */

/** @type {Readonly<ChatLayout>} */
export const FULL_LAYOUT = Object.freeze({
    header: true,
    channelList: true,
    userList: true,
    joinPart: true,
    logout: true,
    shortcuts: true,
});

/** @type {Readonly<ChatLayout>} */
export const HEADLESS_LAYOUT = Object.freeze(
    Object.fromEntries(Object.keys(FULL_LAYOUT).map(key => [key, false])),
);

const PRESETS = { full: FULL_LAYOUT, headless: HEADLESS_LAYOUT };

/**
 * @param {'full'|'headless'|Partial<ChatLayout>|null|undefined} option
 * @return {ChatLayout}
 */
export function resolveLayout(option) {
    if (option === undefined || option === null) {
        return { ...FULL_LAYOUT };
    }
    if (typeof option === 'string') {
        if (!Object.hasOwn(PRESETS, option)) {
            throw new Error(`mountChat: unknown layout "${option}"`);
        }
        return { ...PRESETS[option] };
    }
    const layout = { ...FULL_LAYOUT };
    for (const key of Object.keys(FULL_LAYOUT)) {
        if (Object.hasOwn(option, key)) {
            layout[key] = Boolean(option[key]);
        }
    }
    return layout;
}
