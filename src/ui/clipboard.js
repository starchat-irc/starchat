/**
 * Copies text to the clipboard. Frames on another origin may lack the clipboard-write
 * permission, then a hidden textarea and execCommand('copy') are tried.
 *
 * @param {string} text
 * @return {Promise<boolean>} Whether the text was copied.
 */
export async function copyText(text) {
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Blocked (no focus, no permission): try the fallback
    }

    try {
        const element = Object.assign(document.createElement('textarea'), {
            value: text,
            readOnly: true,
        });
        element.style.position = 'absolute';
        element.style.left = '-9999px';
        document.body.appendChild(element);
        element.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(element);
        return copied !== false;
    } catch {
        return false;
    }
}
