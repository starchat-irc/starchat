# Changelog

Changes that people using StarChat, or running a network or a site with it, will notice. Internal refactors, test changes and dependency updates that change nothing for them are left out.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Below 1.0.0 a minor release may still change options or the discovery format; the release notes say what to adjust.

The section of a released version is the text of its GitHub release, so it is written to stand on its own.

## [Unreleased]

### Added
- DM windows now track the user when they change their names and merge the conversation or change the recipient of the conversation.
- The always-on setting now says that it disables nick changes.

### Fixed
- Previously a web client would just show the entire serverlist no matter if a websocket was available or not.
  isReachable now filters for servers that are reachable for the given environment (desktop, mobile, web) and hides servers that are not available.

## [0.1.1] - 2026-11-26

### Added
- More networks in the server list: OFTC, Rizon, DALnet, EsperNet, hackint, Snoonet, EFnet, IRCnet, QuakeNet and Undernet. All of them are listed for TCP only, so they show up in the desktop and Android apps, not in the browser.
- Attachments can now be removed with an x

### Changed
- Server list entries now say whether the network has a discovery file (`"discovery": true` or `false`). With `false` the client no longer asks for one, which saves a request on every connect. Entries without the field are looked up as before.
- All CSS definitions are now in starchat/theme.css
- Given the gif picker some more spacing from the border.

### Fixed
- Pushed lines without anything to show (reactions, read markers, unknown commands) no longer give an empty notification.
- Adding an image attachment caused the input line to grow in size. The size of the image is now fixed.
- Tipps are now shown smaller and in the right corner.
- Colour palette and nickserv messages are now above the input.

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

[Unreleased]: https://github.com/starchat-irc/starchat/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/starchat-irc/starchat/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/starchat-irc/starchat/releases/tag/v0.1.0
