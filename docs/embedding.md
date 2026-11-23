# Embedding with login

A site that knows its users can log them into the chat with a token. The chat sends it to the primary server with SASL `IRCV3BEARER`, never to another server. For Ergo the token is a JWT, see [One login for IRC and the API](features.md#one-login-for-irc-and-the-api).

## On the same page

```js
mountChat('#chat', {
    primaryServer: 'irc.example.org',
    bearer: async () => ({ token: await fetchChatToken() }),
});
```

The function is called on start and before each reconnect. Return `null` to show the login dialog.

## In an iframe

The chat page asks its parent window:

```js
import { mountChat, bearerFromParent } from 'starchat';

mountChat('#chat', {
    primaryServer: 'irc.example.org',
    bearer: bearerFromParent({ allowedOrigins: ['https://game.example.net'] }),
});
```

Only answers from the direct parent and the listed origins count. `*` is rejected. Without an answer within 10 seconds (`timeout`) the login dialog is shown.

The embedding page answers, to the chat's origin only:

```js
const CHAT_ORIGIN = 'https://chat.example.org';

window.addEventListener('message', async (event) => {
    if (event.origin !== CHAT_ORIGIN || event.data?.type !== 'get-token') return;
    const token = await fetchChatToken();
    event.source.postMessage({ type: 'token-response', token }, CHAT_ORIGIN);
});
```

Fetch a new token each time, an old one may have expired. Limit who may frame the chat with `Content-Security-Policy: frame-ancestors`, using the same origins as `allowedOrigins`.

## Fields of the answer

| Field | Required | Meaning |
|-------|----------|---------|
| `token` | yes | The token. |
| `account` | no | Authorization identity, otherwise taken from the token. |
| `nickname` | no | Nick, the account name by default. |
| `tokenType` | no | Default `jwt`. |
