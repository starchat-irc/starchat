# Documentation

StarChat is an IRCv3 client for the web and the desktop. These pages describe how to put it into a page, how to configure it and what a network can do to work well with it.

StarChat is not released yet. Until the first release it is built from source, see [Install](https://getstarchat.net/install.html).

## Pages

- [mountChat() options](options.md): starting the chat in a page and configuring it
- [Embedding with login](embedding.md): logging in users of your site with a token
- [Server list](servers.md): the public list of networks and how to use your own
- [Discovery file](discovery.md): how a network announces its WebSocket address and extra services
- [Commands and shortcuts](commands.md): slash commands and keyboard shortcuts
- [IRCv3 support](ircv3.md): capabilities and tags StarChat uses

## How it is built

The package has two layers.

`src/core/` is the IRC core without any UI: line parser, CAP and SASL negotiation, WebSocket transport, mIRC formatting, slash commands and the state for messages, nick lists and topics. It also loads the server list, reads the discovery file of each server and keeps features, API access and token per connection. The state is written through a small store adapter, so another UI can plug in its own reactive store.

`src/ui/` is the chat interface, built with Alpine.js and Bootstrap 5. HTML templates live in `src/ui/templates/`, texts in `src/i18n/` (English and German). [`mountChat()`](options.md) renders the templates into an element and starts everything.

Both layers are exported from the package entry, so the core can be used on its own:

```js
import { connectWebSocket, parseIrcLine, saslPlain } from 'starchat';
```

## Connections and networks

There is no central StarChat server. The client connects directly to the IRC network the user picks. Every connection has its own features and its own token, and a token is only sent to the network it belongs to.

A network without any setup works as a plain IRC server, as long as it offers IRC over WebSocket (the web build cannot open TCP connections). A network that wants to offer more serves a [discovery file](discovery.md).

## License

StarChat is licensed under the [AGPL-3.0](../LICENSE). If you run a modified version for others, you have to offer them its source code.
