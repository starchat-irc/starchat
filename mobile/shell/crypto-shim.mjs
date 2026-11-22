/** Node's crypto for desktop/connections.js in the WebView: only randomUUID is used there. */
export function randomUUID() {
    return globalThis.crypto.randomUUID();
}

export default { randomUUID };
