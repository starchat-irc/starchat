# StarChat

An IRCv3 client for the web and the desktop.

StarChat is being extracted from the chat client of [ST-City](https://st-city.net) and is not usable yet. This repository fills up step by step until the first release.

## Planned

- Web build that runs as a static page and can be embedded with `mountChat()`
- Desktop client (Electron) that can also connect over plain TCP
- Public list of IRC networks to pick from (`servers/servers.json`)
- Optional extra services per network (profiles, friends, uploads, voice and more), announced by the network itself through a discovery file at `https://<domain>/.well-known/starchat.json`. Networks without that file work as regular IRC servers.

## Adding a network

Open a pull request that adds an entry to [`servers/servers.json`](servers/servers.json). The format is described in [`servers/servers.schema.json`](servers/servers.schema.json). Check it locally with:

```
npm install
npm run validate:servers
```

The web build needs a WebSocket endpoint (`websocket`). Networks that only offer TCP (`irc`) are shown in the desktop client only.

## License

[AGPL-3.0](LICENSE)
