# Desktop app

The desktop app lives in `desktop/`. It is an Electron shell around the chat: one tab per connection profile, IRC over TCP or WebSocket, chat logs on disk, notifications, a media player and updates. Each tab runs the chat page (`desktop/chat/`) in its own iframe and talks to the shell through `postMessage`.

## Building

```
npm install
cd desktop
npm install
npm start            # development run
npm run dist -- --win    # installers in desktop/dist/ (also --linux, --mac)
npm test
```

`npm start` and `npm run dist` first run `npm run prepare:app`. It checks the edition, builds the chat page with Vite and writes everything the app needs to `desktop/generated/`.

## Editions

Name, ids, icon, servers and texts of the app are set at build time by an edition. The bundled edition in `desktop/edition/` builds StarChat. To build your own app, create a folder with an `edition.json` and your icon, and point the build to it:

```
node scripts/build.mjs dist --win --edition ../my-edition
STARCHAT_EDITION=editions/my-network npm run dist -- --linux
```

The edition is copied into the app package. Users cannot change it after the installation.

If you fork this repository, keep your edition in its own folder (for example `desktop/editions/my-network/`) instead of changing `desktop/edition/`, so merging upstream changes stays free of conflicts. In GitHub Actions, set the repository variable `STARCHAT_EDITION` to that folder.

### edition.json

```json
{
    "$schema": "../edition.schema.json",
    "appName": "Example Chat",
    "appId": "org.example.chat",
    "executableName": "example-chat",
    "icon": "icon.png",
    "chat": {
        "primaryServer": "irc.example.org",
        "defaultChannel": "#lobby"
    },
    "updates": { "provider": "github", "owner": "example", "repo": "example-chat" }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `appName` | yes | Name in window titles, installers and chat texts (`:app`). |
| `appId` | yes | Reverse domain id, for example `org.example.chat`. Never change it after the first release. |
| `executableName` | yes | Name of the installers, the install folder and the Linux program: lower case letters, digits and `-`. On Windows and macOS the program is named after `appName`. |
| `icon` | yes | Square PNG with at least 512x512 pixels. The Windows and macOS icons are made from it. |
| `dataDir` | no | Folder in the user's app data, `executableName` by default. |
| `formerDataDirs` | no | Folders of older versions of your app. While `dataDir` does not exist, the first of these that exists is used, so profiles and logs stay. |
| `publisher` | no | Copyright and vendor in the installers. |
| `splashImage` | no | Image on the start screen, the icon by default. |
| `chat.primaryServer` | no | Domain of your network. The app then has a "Home Server" tab for new connections, starts with a connection to it, and takes login, API and features from its [discovery file](discovery.md). Without it (the StarChat app) the user picks the first network from the directory or sets up a server, like in other desktop IRC clients. |
| `chat.networkName` | no | Name of the primary network in tabs and the connections list, the domain by default. |
| `chat.serverList` | no | Directory of networks for new connections: `'default'` (the public list), an https URL of your own list, or `false`. The build bundles the list (`'default'`: the version in this checkout, a URL: downloaded during the build), the app loads newer versions at runtime, so new networks need no app update. |
| `chat.defaultChannel` | no | Channel joined after login on the primary server. |
| `chat.theme` | no | `auto`, `dark` or `light`. |
| `chat.themeCss` | no | CSS file loaded after the bundled theme, see [Theme](options.md#theme). |
| `chat.modules` | no | Names of the feature modules to ship, all by default. |
| `chat.ctcpVersion`, `chat.defaultQuitMessage` | no | As in [mountChat()](options.md). |
| `texts` | no | Texts that replace bundled ones, per language: `{ "de": { "key": "Text" } }`. Keys of the chat (`src/i18n/`) and of the app windows (`desktop/locales/`). |
| `updates` | no | Where the app looks for new versions: `{ "provider": "github", "owner", "repo" }` or `{ "provider": "generic", "url" }`. Without it the app does not update itself. |
| `chatBundles` | no | Signed chat updates without a new installer: `{ "manifestUrl", "publicKey" }` (PEM file in the edition folder). |

All file paths are relative to the edition folder and must stay inside it. The full schema is `desktop/edition.schema.json`.

### Features of the primary server

Only for editions with `chat.primaryServer`. Some parts of the app need an API on the primary server and turn on only when its discovery file offers them. The Spotify link, for example, needs the feature [`spotify`](discovery.md#spotify). Without a discovery file the app is a plain IRC client.

## Connections

Each tab is a connection profile: the primary server of the edition (if it has one) or another server, over TCP (with or without TLS) or a secure WebSocket. TCP sockets are opened by the app, the chat page reaches them through `nativeSocket` (see [mountChat() options](options.md)). Profiles are managed under Settings, Connections. Passwords and tokens are stored encrypted with the system keychain (Electron `safeStorage`) and never shown again. They only go to the server they were stored for: a connection to the primary server remembers that server and its credentials are dropped when the edition names another one (older connections without it are bound on the first start), and changing the address of another connection, or switching TLS off, drops its stored password and token. "Remember me" in the login dialog keeps the API token of a password login for the next start.

## IRC links

Installed apps register as handler for `irc://` and `ircs://` links, for example `ircs://irc.libera.chat:6697/#libera`. A link to a server that has a connection opens its tab and the channel. Links to other servers open the dialog for a new connection with the server filled in, nothing connects without the user.

## Chat updates without a new installer

With `chatBundles` in the edition, installed apps fetch a signed chat page from `manifestUrl` and use it from the next start. A chat that does not start within 20 seconds is dropped and the built-in one is used again. Updates that need a newer app (`starchat.nativeApi` in `desktop/package.json`) are skipped.

Create a key pair once and keep the private key secret:

```
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out chat-signing-key.pem
openssl ec -in chat-signing-key.pem -pubout -out edition/chat-bundle-public.pem
```

Build and sign the chat page of your edition, then upload the folder so that `manifest.json` is reachable at `manifestUrl`:

```
cd desktop
npm run chat-bundle -- --key ../chat-signing-key.pem --out ../chat-update --edition editions/my-network
```

## Releases

The workflow `.github/workflows/desktop.yml` builds Windows, Linux and macOS. A push to `main` replaces the installers on the pre-release `latest-dev`. A tag `v*` attaches installers and update files to the release of the tag, next to the web package. The builds are not signed yet, so Windows SmartScreen and macOS Gatekeeper warn on the first start.
