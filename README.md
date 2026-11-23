# StarChat

An IRCv3 client for the web and the desktop. [Website](https://getstarchat.net) · [Web demo](https://getstarchat.net/demo/) · [Documentation](https://getstarchat.net/docs/)

StarChat connects directly to the IRC network the user picks. There is no central StarChat server. It works on any network that offers IRC over WebSocket (and TCP + TLS in downloadable clients), and uses IRCv3 where the server supports it: history, reactions, replies, typing indicators, read markers, multiline messages, avatars and push notifications.

A network can offer more through a small [discovery file](docs/discovery.md) on its own domain: profiles, friends, uploads, GIF search, communities, events, voice chat and more. Each of these is an optional module and stays hidden on networks that do not offer it. See [Features](docs/features.md) for what works where.

StarChat started as the chat client of [ST-City](https://st-city.net) and was moved into its own project.

## Status

The current version is on the [releases page](https://github.com/starchat-irc/starchat/releases/latest): the web package, the desktop installers for Windows, Linux and macOS, and the package for Google Play. The library is on npm as [`starchat`](https://www.npmjs.com/package/starchat). The Android app comes to Google Play after its test phase there (testers needed). What changed in each version is in the [changelog](CHANGELOG.md).

Development builds of `main` are under [latest-dev](https://github.com/starchat-irc/starchat/releases/tag/latest-dev), rebuilt on every change.

## Using it

The web client itself is a static page. Download the .zip from the [releases](https://github.com/starchat-irc/starchat/releases/latest) page, set your network in `config.json` and upload the folder to any web host. All settings are in [Hosting the web client](docs/hosting.md).

To build it yourself: `npm install`, then `npm run build:web` (output in `dist-web/`) or `npm run web` to try it locally.

To put the chat into your own page, use it as a library: `npm install starchat`, or build it yourself with `npm run build` (output in `dist/`).

```js
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import 'starchat/theme.css';
import { mountChat } from 'starchat';

mountChat('#chat', {
    primaryServer: 'irc.example.org',
    defaultChannel: '#lobby',
});
```

All options are in [`docs/options.md`](docs/options.md). Users of your site can be logged in without the login dialog, see [Embedding with login](docs/embedding.md).

## Documentation

The pages in [`docs/`](docs/) are published at [getstarchat.net/docs](https://getstarchat.net/docs/):

- [Features](docs/features.md): what works on every network and what a network can add
- [Hosting the web client](docs/hosting.md)
- [Desktop app](docs/desktop.md)
- [mountChat() options](docs/options.md)
- [Embedding with login](docs/embedding.md)
- [Server list](docs/servers.md)
- [Discovery file](docs/discovery.md), including the API of each feature
- [Commands and shortcuts](docs/commands.md)
- [IRCv3 support](docs/ircv3.md)

## Development

Node.js 22.12 or newer.

```
npm install
npm test             # unit tests (Vitest)
npm run build        # library build to dist/
npm run build:docs   # docs to dist-docs/
```

- `src/core/` is the IRC core without any UI: parser, CAP and SASL, WebSocket transport, formatting, commands, server list, discovery and the state of messages, nick lists and topics. 
- `src/ui/` is the interface (Alpine.js and Bootstrap 5, templates in `src/ui/templates/`, texts in `src/i18n/`). 
- `src/modules/` holds the optional features, one file per feature. The [overview](docs/index.md) explains how the parts fit together.

### Changelog

Anything a user of StarChat or an operator of a network would notice gets one line under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md). For a release, that section becomes `## [x.y.z] - date`, the version in `package.json`, `desktop/package.json` and `mobile/package.json` is raised to match, and the tag `vx.y.z` is pushed.

## Adding a network

Open a pull request that adds an entry to [`servers/servers.json`](servers/servers.json). The format is described in [Server list](docs/servers.md) and checked against [`servers/servers.schema.json`](servers/servers.schema.json):

```
npm install
npm run validate:servers
```

The web client needs a WebSocket endpoint (`websocket`). Networks that only offer TCP (`irc`) are shown in the desktop client only.

## License

[MIT License](LICENSE).
