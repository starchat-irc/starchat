# Hosting the web client

The web client is a static page. It needs no server of its own, any web host works (GitHub Pages, Cloudflare Pages, nginx, a shared host). Download it, set your network in `config.json` and upload the folder.

## Download

| Build | Where |
|-------|-------|
| Release | `starchat-web-<version>.zip` or `.tar.gz` on the [releases page](https://github.com/starchat-irc/starchat/releases). |
| Development build | `starchat-web-dev.zip` or `.tar.gz` under [latest-dev](https://github.com/starchat-irc/starchat/releases/tag/latest-dev). Built from `main` on every change and replaced each time. For testing, not for production. |

The archive contains one folder, `starchat-web/`:

| File | |
|------|---|
| `index.html` | The page. |
| `config.json` | Your settings, see below. |
| `assets/` | Scripts, styles and fonts. Voice chat parts load only when used. |
| `push-sw.js` | Service worker for push notifications. Must stay next to `index.html`. |
| `favicon.svg` | Replace it with your own icon if you like. |
| `build.json` | Version and commit of the build. |

Paths are relative, so the folder can live at the root of a domain or in a subfolder such as `https://example.org/chat/`.

## config.json

```json
{
    "primaryServer": "irc.example.org",
    "defaultChannel": "#lobby",
    "serverList": "default",
    "appName": "Example Chat",
    "notice": "Connecting shares your IP address with the network.",
    "links": [
        { "label": "Privacy", "url": "https://example.org/privacy" },
        { "label": "Imprint", "url": "https://example.org/imprint" }
    ]
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `primaryServer` | | Required. Domain of your network, preselected in the login dialog. Its WebSocket address comes from the [server list](servers.md) or from the network's [discovery file](discovery.md). |
| `defaultChannel` | | Channel joined after login, on the primary server only. |
| `serverList` | `"default"` | `"default"` offers the public list too, an `https://` URL your own list, `false` only your network. |
| `appName` | `"StarChat"` | Name in texts, the page title and push notifications. |
| `title` | `appName` | Page title, if it should differ. |
| `theme` | `"auto"` | `"auto"`, `"dark"` or `"light"`. Users can change it. |
| `locale` | browser | Language code or list, for example `"de"`. |
| `overrides` | | Texts that replace bundled ones, by key (see `src/i18n/en.json`). |
| `modules` | all | Names of the [features](features.md) to load, for example `["profiles", "uploads"]`. `[]` gives a plain IRC client. |
| `push` | `true` | `false` turns off browser push notifications. |
| `notice` | | Text in a bar above the chat. |
| `links` | | Links in that bar, `{ "label", "url" }`, `https` only. Put your privacy policy and imprint here if you need them. |
| `ctcpVersion` | `"StarChat"` | Answer to CTCP VERSION. |
| `defaultQuitMessage` | | Quit message until the user sets one. |
| `urlParameters` | `true` | Allow `?server=<domain>`, `?lang=` and `?theme=` in the address, for example to link to another network. `false` ignores them. |

Other keys are ignored. Options that need code, such as login through your site (`bearer`), are only available when you [embed the chat](embedding.md) in your own page.

The file is fetched without cache on every start, so a change applies as soon as it is uploaded.

## What your network needs

- **IRC over WebSocket** with TLS (`wss://`). Ergo, UnrealIRCd 6 and InspIRCd (`m_websocket`) support it.
- **Allowed origins:** if your server only accepts listed origins (Ergo: `server.websockets.allowed-origins`), add the address of the page, for example `https://example.org`.
- **Discovery file** (optional): lets users type your domain and turns on extra [features](features.md).

## Updating

Download the new archive and replace everything except `config.json` (and your `favicon.svg`). New releases may add keys, older files keep working.
