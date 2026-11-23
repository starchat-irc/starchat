# Changelog

Changes that people using StarChat, or running a network or a site with it, will notice. Internal refactors, test changes and dependency updates that change nothing for them are left out.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Below 1.0.0 a minor release may still change options or the discovery format; the release notes say what to adjust.

The section of a released version is the text of its GitHub release, so it is written to stand on its own.

## [Unreleased]

## [0.1.0] - 2026-11-23

The first release. StarChat is an IRCv3 client for the web, the desktop and Android. It connects directly to the network the user picks, there is no central StarChat server.

### Added
- **Web client** to host as a static page: `starchat-web-0.1.0.zip`, network and channels in `config.json`. See [Hosting the web client](https://getstarchat.net/docs/hosting.html).
- **Library** on npm (`npm install starchat`) with `mountChat()`. Users of your site can be logged in by the page, and `layout: 'headless'` gives a chat box without frame for games. See [mountChat() options](https://getstarchat.net/docs/options.html).
- **Desktop app** for Windows, Linux and macOS: several networks at once, plain TCP for networks without WebSocket, `irc://` links, updates from this release page.
- **Android app**, built from the same chat. It comes to Google Play after the test phase there. (Testers needed)
- **IRCv3** where the server offers it: history, reactions, replies, typing indicators, deleting messages, multiline messages, read markers shared across sessions, avatars and push notifications. See [IRCv3 support](https://getstarchat.net/docs/ircv3.html).
- **Discovery file** (`/.well-known/starchat.json`): a network can offer profiles, friends, uploads, GIF search, communities, events, voice chat and calls. Each is optional and stays hidden on networks without it. Networks whose IRC server cannot check tokens (Anope, for example) log in to the API with `api-login`. See [Features](https://getstarchat.net/docs/features.html).
- **Server list** of networks to pick from. Networks are added by pull request to `servers/servers.json`. Feel free to add your own.
- **Translations**: English and German
- **Themes**: light and dark theme.

### Notes
- The desktop installers are not signed yet. Windows SmartScreen and macOS Gatekeeper warn on the first start.
- `starchat-android-0.1.0-play.aab` is the package for Google Play and cannot be installed directly. If there's demand for the .apk, I'll make one.

[Unreleased]: https://github.com/starchat-irc/starchat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/starchat-irc/starchat/releases/tag/v0.1.0
