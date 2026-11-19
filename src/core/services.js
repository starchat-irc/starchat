/** Nicks of common IRC services. Their replies belong in the server window, not in a DM. */
const SERVICE_NICKS = new Set([
    'nickserv', 'chanserv', 'hostserv', 'histserv', 'memoserv', 'operserv',
    'botserv', 'saslserv', 'infoserv', 'statserv', 'global', 'alis',
]);

/**
 * @param {string} nick
 * @return {boolean}
 */
export function isServiceNick(nick) {
    return typeof nick === 'string' && SERVICE_NICKS.has(nick.toLowerCase());
}
