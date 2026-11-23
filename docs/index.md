# Documentation

StarChat is an IRCv3 client for the web, the desktop and Android. Downloads are on the [releases page](https://github.com/starchat-irc/starchat/releases/latest), the library is on npm as `starchat`, changes are in the [changelog](https://github.com/starchat-irc/starchat/blob/main/CHANGELOG.md).

There is no central StarChat server. The client connects directly to the network the user picks. A network without any setup works as a plain IRC server, as long as it offers IRC over WebSocket. A network that wants to offer more serves a [discovery file](discovery.md).

## How it is built

`src/core/` is the IRC core without UI: parser, CAP and SASL, WebSocket transport, mIRC formatting, slash commands, server list, discovery and the state of messages, nick lists and topics. The state goes through a small store adapter, so another UI can plug in its own store.

`src/ui/` is the interface, built with Alpine.js and Bootstrap 5. Templates are in `src/ui/templates/`, texts in `src/i18n/`. [`mountChat()`](options.md) renders it into an element.

Both are exported from the package, so the core can be used on its own:

```js
import { connectWebSocket, parseIrcLine, saslPlain } from 'starchat';
```

`desktop/` and `mobile/` are the [desktop](desktop.md) and [Android](mobile.md) apps around the same chat.

StarChat is licensed under the [MIT License](../LICENSE).
