# Hosting the web client

The web client is a static page, any web host works. Download `starchat-web-<version>.zip` from the [releases page](https://github.com/starchat-irc/starchat/releases/latest), set your network in `config.json` and upload the folder. It also works in a subfolder such as `https://example.org/chat/`.

A build of the latest `main` is under [latest-dev](https://github.com/starchat-irc/starchat/releases/tag/latest-dev), for testing.

## config.json

```json
{
    "primaryServer": "irc.example.org",
    "defaultChannel": "#lobby",
    "appName": "Example Chat",
    "notice": "Connecting shares your IP address with the network.",
    "links": [
        { "label": "Privacy", "url": "https://example.org/privacy" }
    ]
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `primaryServer` | | Required. Domain of your network. |
| `defaultChannel` | | Channel joined after login. |
| `serverList` | `"default"` | `"default"` offers the public list too, an `https://` URL your own list, `false` only your network. |
| `appName` | `"StarChat"` | Name in texts, page title and notifications. |
| `title` | `appName` | Page title, if it should differ. |
| `theme` | `"auto"` | `"auto"`, `"dark"` or `"light"`. |
| `locale` | browser | Language code or list. |
| `overrides` | | Replaced texts by key (see `src/i18n/en.json`). |
| `modules` | all | [Features](features.md) to load. `[]` gives a plain IRC client. |
| `push` | `true` | `false` turns off browser push. |
| `notice` | | Text in a bar above the chat. |
| `links` | | Links in that bar, for example privacy policy and imprint. |
| `ctcpVersion` | `"StarChat"` | Answer to CTCP VERSION. |
| `defaultQuitMessage` | | Quit message until the user sets one. |
| `urlParameters` | `true` | Allow `?server=`, `?lang=` and `?theme=` in the address. |

The file is loaded without cache, so changes apply right away. Login through your own site (`bearer`) needs [embedding](embedding.md).

## What your network needs

- IRC over WebSocket with TLS (`wss://`). Ergo, UnrealIRCd 6 and InspIRCd support it.
- If the server checks origins (Ergo: `server.websockets.allowed-origins`), the address of your page.
- Optionally a [discovery file](discovery.md), so users can type your domain.

## Updating

Replace everything except `config.json` and your `favicon.svg`.
