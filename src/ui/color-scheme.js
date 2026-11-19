/**
 * Light or dark colours of the chat ([data-bs-theme] in the theme CSS).
 */

const stopFollowing = new WeakMap();

/**
 * Sets data-bs-theme on the chat element only, so an embedding page keeps its own
 * colours. 'auto' follows the system setting and changes along with it; a later call
 * for the same element replaces the earlier one.
 *
 * @param {Element} element
 * @param {'auto'|'dark'|'light'} theme
 */
export function applyColorScheme(element, theme = 'auto') {
    stopFollowing.get(element)?.();
    stopFollowing.delete(element);

    if (theme === 'dark' || theme === 'light') {
        element.setAttribute('data-bs-theme', theme);
        return;
    }
    const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    const update = () => element.setAttribute('data-bs-theme', query?.matches ? 'light' : 'dark');
    update();
    if (query?.addEventListener) {
        query.addEventListener('change', update);
        stopFollowing.set(element, () => query.removeEventListener('change', update));
    }
}
