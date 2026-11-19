# StarChat

An IRCv3 client for the web and the desktop.

StarChat is being extracted from the chat client of [ST-City](https://st-city.net) and is not usable yet. This repository fills up step by step until the first release.

## Planned

- Web build that runs as a static page and can be embedded with `mountChat()`
- Desktop client (Electron) that can also connect over plain TCP
- Public list of IRC networks to pick from (`servers/servers.json`)
- Optional extra services per network (profiles, friends, uploads, voice and more), announced by the network itself through a discovery file at `https://<domain>/.well-known/starchat.json`. Networks without that file work as regular IRC servers. The format is described in [`docs/discovery.md`](docs/discovery.md).

## Development

Node.js 22.12 or newer.

```
npm install
npm test          # unit tests (Vitest)
npm run build     # library build to dist/
```

`src/core/` holds the IRC core without any UI: line parser, CAP/SASL negotiation, WebSocket transport, mIRC formatting, slash commands and the state for messages, nick lists and topics. The state is written through a small store adapter, so the UI can plug in its own reactive store.

It also loads the server list (cached, with the shipped copy as fallback), reads the discovery file of each server and keeps features, API access and token per connection, so a token is never sent to another network.

## Embedding with login

A site that already knows its users can log them into the chat with a token instead of the login dialog. The chat sends the token to its primary server with SASL `IRCV3BEARER` (for Ergo a JWT signed with the key from its config), the server checks it. The token is never sent to another server.

On the same page, pass a function that returns a token:

```js
mountChat('#chat', {
    primaryServer: 'irc.example.org',
    bearer: async () => ({ token: await fetchChatToken() }),
});
```

It is called on start and before each reconnect, so short-lived tokens work. Return `null` to show the login dialog.

In an iframe, the chat page asks its parent window:

```js
import { mountChat, bearerFromParent } from 'starchat';

mountChat('#chat', {
    primaryServer: 'irc.example.org',
    bearer: bearerFromParent({ allowedOrigins: ['https://game.example.net'] }),
});
```

The chat posts `{ type: 'get-token' }` to the parent and only takes the answer from the direct parent window and from the listed origins (its own origin is always allowed). `allowedOrigins` is set by whoever serves the chat page, not by the embedding site. Without an answer within 10 seconds the login dialog is shown.

The embedding page answers with the token. Check the origin and send the answer to that origin only, never to `'*'`:

```js
const CHAT_ORIGIN = 'https://chat.example.org';

window.addEventListener('message', async (event) => {
    if (event.origin !== CHAT_ORIGIN || event.data?.type !== 'get-token') return;
    const token = await fetchChatToken();
    event.source.postMessage({ type: 'token-response', token }, CHAT_ORIGIN);
});
```

Optional fields in the answer: `account` (authorization identity; leave it out and the server takes the account from the token), `nickname` (nick for the registration, otherwise the account) and `tokenType` (default `jwt`).

The server of the chat page should also limit who may frame it, with `Content-Security-Policy: frame-ancestors https://game.example.net`.

## Adding a network

Open a pull request that adds an entry to [`servers/servers.json`](servers/servers.json). The format is described in [`servers/servers.schema.json`](servers/servers.schema.json). Check it locally with:

```
npm install
npm run validate:servers
```

The web build needs a WebSocket endpoint (`websocket`). Networks that only offer TCP (`irc`) are shown in the desktop client only.

## License

[AGPL-3.0](LICENSE)
