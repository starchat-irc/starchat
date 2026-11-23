# Desktop app

The desktop app lives in `desktop/`. It is an Electron shell around the chat: one tab per connection, IRC over TCP or WebSocket, logs on disk, notifications and updates.

## Building

```
npm install
cd desktop
npm install
npm start                # development run
npm run dist -- --win    # installers in desktop/dist/ (also --linux, --mac)
npm test
```

## Editions

Name, ids, icon, servers and texts are set at build time by an edition. `desktop/edition/` builds StarChat. For your own app, create a folder with an `edition.json` and an icon:

```
node scripts/build.mjs dist --win --edition ../my-edition
```

In a fork, keep it in its own folder such as `desktop/editions/my-network/`, so upstream merges stay free of conflicts, and set the repository variable `STARCHAT_EDITION` for GitHub Actions.

### edition.json

```json
{
    "$schema": "../edition.schema.json",
    "appName": "Example Chat",
    "appId": "org.example.chat",
    "executableName": "example-chat",
    "icon": "icon.png",
    "chat": { "primaryServer": "irc.example.org", "defaultChannel": "#lobby" },
    "updates": { "provider": "github", "owner": "example", "repo": "example-chat" }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `appName` | yes | Name in window titles, installers and texts. |
| `appId` | yes | Reverse domain id. Never change it after the first release. |
| `executableName` | yes | Name of installers and install folder: lower case, digits and `-`. |
| `icon` | yes | Square PNG, at least 512x512. |
| `dataDir` | no | Folder in the user's app data, `executableName` by default. |
| `formerDataDirs` | no | Data folders of older versions, used while `dataDir` does not exist. |
| `publisher` | no | Vendor in the installers. |
| `splashImage` | no | Start screen image, the icon by default. |
| `chat.primaryServer` | no | Domain of your network. The app starts with it and takes login and features from its [discovery file](discovery.md). Without it the user picks a network. |
| `chat.networkName` | no | Name of that network, the domain by default. |
| `chat.serverList` | no | `'default'`, an https URL of your own list, or `false`. Bundled at build time, refreshed at runtime. |
| `chat.defaultChannel` | no | Channel joined on the primary server. |
| `chat.theme`, `chat.themeCss` | no | `auto`, `dark` or `light`, and a CSS file, see [Theme](options.md#theme). |
| `chat.modules` | no | Feature modules to ship, all by default. |
| `chat.ctcpVersion`, `chat.defaultQuitMessage` | no | As in [mountChat()](options.md). |
| `texts` | no | Replaced texts per language, keys from `src/i18n/` and `desktop/locales/`. |
| `updates` | no | `{ "provider": "github", "owner", "repo" }` or `{ "provider": "generic", "url" }`. Without it there are no updates. |
| `chatBundles` | no | Chat updates without a new installer, see below. |

Paths are relative to the edition folder. The schema is `desktop/edition.schema.json`.

## Connections

Each tab is a profile, over TCP, TLS or WebSocket, managed under Settings, Connections. Passwords and tokens are encrypted with the system keychain and only go to the server they were stored for. Changing the address drops them.

The app opens `irc://` and `ircs://` links. A link to a known server opens its tab and channel, any other opens the new connection dialog.

## Chat updates without a new installer

With `"chatBundles": { "manifestUrl", "publicKey" }` the app fetches a signed chat page and uses it from the next start. If it does not start within 20 seconds, the built-in one is used again.

```
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out chat-signing-key.pem
openssl ec -in chat-signing-key.pem -pubout -out edition/chat-bundle-public.pem
cd desktop
npm run chat-bundle -- --key ../chat-signing-key.pem --out ../chat-update --edition editions/my-network
```

Upload the output so that `manifest.json` is at `manifestUrl`. Keep the private key out of the repository.

## Releases

`.github/workflows/desktop.yml` builds Windows, Linux and macOS. A push to `main` updates the pre-release `latest-dev`, a tag `v*` attaches installers and update files to the release. The builds are not signed yet, so Windows and macOS warn on the first start.
