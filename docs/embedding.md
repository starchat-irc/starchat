# Embedding with login

A site that already knows its users can log them into the chat with a token instead of the login dialog. The chat sends the token to its primary server with SASL `IRCV3BEARER`, and the server checks it. For Ergo that is a JWT signed with the key from its config. The token is never sent to another server.

## On the same page

Pass a function that returns a token:

```js
mountChat('#chat', {
    primaryServer: 'irc.example.org',
    bearer: async () => ({ token: await fetchChatToken() }),
});
```

It is called on start and before each reconnect, so short-lived tokens work. Return `null` to show the login dialog. If the function throws, the last token is used again.

## In an iframe

The chat page asks its parent window:

```js
import { mountChat, bearerFromParent } from 'starchat';

mountChat('#chat', {
    primaryServer: 'irc.example.org',
    bearer: bearerFromParent({ allowedOrigins: ['https://game.example.net'] }),
});
```

The chat posts `{ type: 'get-token' }` to the parent and only takes the answer from the direct parent window and from the listed origins (its own origin is always allowed). `allowedOrigins` is set by whoever serves the chat page, not by the embedding site. `*` and origins with a path are rejected. Without an answer within 10 seconds (option `timeout`, in milliseconds) the login dialog is shown.

The embedding page answers with the token. Check the origin and send the answer to that origin only, never to `'*'`:

```js
const CHAT_ORIGIN = 'https://chat.example.org';

window.addEventListener('message', async (event) => {
    if (event.origin !== CHAT_ORIGIN || event.data?.type !== 'get-token') return;
    const token = await fetchChatToken();
    event.source.postMessage({ type: 'token-response', token }, CHAT_ORIGIN);
});
```

Fetch a new token for every `get-token`. The chat asks again before each reconnect, and an old token may have expired by then.

## Fields of the answer

| Field | Required | Meaning |
|-------|----------|---------|
| `token` | yes | The token. |
| `account` | no | Authorization identity. Leave it out and the server takes the account from the token. |
| `nickname` | no | Nick for the registration. Without it the account name is used. |
| `tokenType` | no | Token type sent to the server, default `jwt`. |

## Notes

- The token only goes to the primary server. If the user picked another network in the login dialog before, the chat switches back to the primary server. Logging in as a guest or with a password drops the token.
- The server of the chat page should limit who may frame it, with `Content-Security-Policy: frame-ancestors https://game.example.net`. Use the same list as `allowedOrigins`.
