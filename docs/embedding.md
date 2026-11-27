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

### In a box of an existing page

The chat fills the element it is mounted into, so give that element a height. The theme does not style anything outside the chat.

```js
import 'starchat/theme.css';
import { mountChat } from 'starchat';

mountChat('#hub-chat', {
    primaryServer: 'irc.example.org',
    defaultChannel: '#hub',
    layout: 'headless',              // only messages and the input line
    modules: [],                     // no API features, or only the ones you need
    Alpine: window.Alpine,           // the page already runs Alpine (e.g. Livewire)
    bearer: async () => ({ token: await fetchChatToken() }),
});
```

- Load Bootstrap before `starchat/theme.css`. The theme overrides some Bootstrap rules of the same specificity, so it has to come later.
- Pass the page's Alpine instance.
- The IRC server sees the page's origin on the WebSocket. With Ergo, add it to `server.websockets.allowed-origins`.

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
