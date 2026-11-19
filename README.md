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

## Documentation

The docs are in [`docs/`](docs/) and published at [getstarchat.net/docs](https://getstarchat.net/docs/): `mountChat()` options, [embedding with login](docs/embedding.md), server list, [discovery file](docs/discovery.md), commands and IRCv3 support. Build them locally with `npm run build:docs` (output in `dist-docs/`, styled only inside the website).

## Adding a network

Open a pull request that adds an entry to [`servers/servers.json`](servers/servers.json). The format is described in [`servers/servers.schema.json`](servers/servers.schema.json). Check it locally with:

```
npm install
npm run validate:servers
```

The web build needs a WebSocket endpoint (`websocket`). Networks that only offer TCP (`irc`) are shown in the desktop client only.

## License

[AGPL-3.0](LICENSE)
