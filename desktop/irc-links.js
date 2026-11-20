'use strict';

/**
 * irc:// and ircs:// links (the common IRC URL form, e.g. ircs://irc.libera.chat:6697/#libera).
 * The app is registered as their handler. A link to a server that already has a connection
 * profile opens that tab and the channel; other links prefill the dialog for a new
 * connection, so a click never connects to an unknown server by itself.
 *
 * Free of Electron imports so it can be unit-tested.
 */

const SCHEMES = ['irc', 'ircs'];
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\[[0-9a-f:.]+\]$/i;
const CHANNEL = /^[#&][^\s,\x07]{1,49}$/;

/**
 * @param {string} raw
 * @return {{ host: string, port: number, tls: boolean, channel: string }|null}
 */
function parseIrcUrl(raw) {
    let url;
    try {
        url = new URL(String(raw || '').trim());
    } catch {
        return null;
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (!SCHEMES.includes(scheme) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!HOST.test(host)) return null;
    const tls = scheme === 'ircs';
    const port = url.port ? Number(url.port) : (tls ? 6697 : 6667);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

    // The channel is the path (irc://host/channel) or the fragment (irc://host/#channel)
    let target = '';
    try {
        target = decodeURIComponent(url.hash || url.pathname.replace(/^\//, ''));
    } catch {
        return { host, port, tls, channel: '' };
    }
    target = target.split(',')[0].trim();
    if (target && !/^[#&]/.test(target)) target = `#${target}`;
    const channel = CHANNEL.test(target) ? target.toLowerCase() : '';
    return { host, port, tls, channel };
}

/** First irc:// or ircs:// argument of a command line (Windows and Linux pass links that way). */
function ircUrlFromArgs(argv = []) {
    return argv.find(arg => typeof arg === 'string' && /^ircs?:\/\//i.test(arg)) || null;
}

function hostOfWebsocket(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Connection profile for a link: an external profile with the same host, else a home
 * profile when the host belongs to the edition's primary server, else null.
 *
 * @param {Object[]} profiles stored profiles
 * @param {{ host: string }} link
 * @param {string} primaryServer domain of the edition
 * @param {string} [activeHash] preferred among several matching profiles
 */
function profileForLink(profiles, link, primaryServer, activeHash = '') {
    const list = Array.isArray(profiles) ? profiles : [];
    const external = list.filter((profile) => {
        if (profile?.serverType !== 'external') return false;
        const ext = profile.externalServer || {};
        const host = ext.connectionType === 'websocket' ? hostOfWebsocket(ext.websocketUrl) : String(ext.host || '').toLowerCase();
        return host === link.host;
    });
    const primary = String(primaryServer || '').toLowerCase();
    const isPrimary = primary && (link.host === primary || link.host.endsWith(`.${primary}`));
    const candidates = external.length ? external : (isPrimary ? list.filter(profile => profile?.serverType !== 'external') : []);
    return candidates.find(profile => profile.hash === activeHash) || candidates[0] || null;
}

module.exports = { SCHEMES, parseIrcUrl, ircUrlFromArgs, profileForLink };
