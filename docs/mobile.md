# Mobile app

The mobile app lives in `mobile/`. It is a Capacitor shell around the chat, like the [desktop app](desktop.md) is an Electron shell. Android is in `mobile/android/`, iOS will follow in `mobile/ios/`.

The shell (`mobile/shell/`) runs the chat page (`mobile/chat/`) of the connection on screen in an iframe and talks to it through `postMessage`. Everything close to the device is native (`mobile/android/app/src/main/java/net/getstarchat/app/`): IRC over TCP and TLS, the encrypted store for passwords and tokens (Android Keystore), push notifications, sharing from other apps and the back button.

## Building

Needed once: JDK 21, the Android SDK and Node.js 22. Paths that are not in the environment go into `mobile/build.local.json` (not in git):

```json
{
    "javaHome": "C:/Java/jdk-21",
    "androidHome": "C:/Android/Sdk",
    "gradleUserHome": "C:/gradle-home"
}
```

```
npm install
cd mobile
npm install
npm run apk          # debug APK in mobile/dist/
npm run aab          # signed App Bundle for Google Play in mobile/dist/
npm test             # shell and edition
npm run test:android # Java unit tests (after a build)
```

`npm run apk` first runs `npm run prepare:app`. It checks the edition, writes `mobile/generated/` (edition, server list, Android resources), builds shell and chat page with Vite into `mobile/www/` and copies them into the Android project. `npm run open` opens the project in Android Studio.

`node scripts/build.mjs apk-release` builds a signed APK to pass around, with the key from `keystore.properties` (see [Releases](#releases)).

### Development builds

`--dev` builds the development app: it gets the id `devAppId` of the edition (`appId` plus `.dev` by default) and the name "StarChat Dev", so it installs next to the released app. Development versions are `0.0.0-dev.<number>`, the number is the versionCode:

```
STARCHAT_VERSION=0.0.0-dev.7 node scripts/build.mjs apk-release --dev
```

The workflow `.github/workflows/android.yml` does this on every push to `main` and attaches the APK as `starchat-android-dev.apk` to the pre-release `latest-dev`. Every build installs over the one before, as long as it is signed with the same key. The workflow needs these repository secrets:

| Secret | Content |
|--------|---------|
| `ANDROID_KEYSTORE` | The signing key, base64 encoded: `base64 -w0 dev.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Its password. Key and store need the same one, which `keytool` sets up by default. |
| `GOOGLE_SERVICES_JSON` | Optional: the content of `google-services.json`. It must contain the Android app `devAppId`. Without it the app has no push. |

Use a key of its own for development builds, not the upload key for Google Play. Without `ANDROID_KEYSTORE` the workflow builds nothing, so forks without keys stay green. A fork picks its edition with the repository variable `STARCHAT_MOBILE_EDITION`.

## Editions

Name, id, icons, servers and texts are set at build time by an edition, as for the desktop app. The bundled edition in `mobile/edition/` builds StarChat. For your own app, create a folder with an `edition.json` and your icons and point the build to it:

```
node scripts/build.mjs apk --edition ../my-edition
STARCHAT_EDITION=editions/my-network npm run aab
```

If you fork this repository, keep your edition in its own folder (for example `mobile/editions/my-network/`), so merging upstream changes stays free of conflicts.

### edition.json

```json
{
    "$schema": "../edition.schema.json",
    "appName": "Example Chat",
    "appId": "org.example.chat",
    "icon": "icon.png",
    "adaptiveIcon": { "foreground": "icon-foreground.png", "background": "#20232a" },
    "chat": {
        "primaryServer": "irc.example.org",
        "defaultChannel": "#lobby"
    },
    "push": { "googleServices": "google-services.json" }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `appName` | yes | Name under the launcher icon and in chat texts (`:app`), at most 30 characters. |
| `appId` | yes | Android application id, for example `org.example.chat`. Never change it after the first release: Google Play and the stored data of the users are bound to it. |
| `devAppId` | no | Id of the development build (`--dev`), `appId` plus `.dev` by default. |
| `icon` | yes | Square PNG with at least 512x512 pixels: launcher icon on Android 7, start screen, connection list. |
| `adaptiveIcon` | no | Launcher icon from Android 8 on: `foreground` (transparent PNG of at least 432x432 pixels or an Android vector drawable `.xml`, motif inside the middle 66 percent) and `background` (`#rrggbb`). Without it the icon is shown smaller on a white background. |
| `splashBackground` | no | Colour of the start screen, `#rrggbb`. |
| `chat.primaryServer` | no | Domain of your network. The app then starts with a connection to it and takes login, API and features from its [discovery file](discovery.md). Without it (the StarChat app) the first start offers the server list and a form for an own server; the chat then asks for the login (account or guest). |
| `chat.networkName` | no | Name of the primary network in the connection list, the domain by default. |
| `chat.serverList` | no | Directory of networks: `'default'` (the public list), an https URL of your own list, or `false`. The build bundles the list, the app loads newer versions once a day. Your own list must be served with `Access-Control-Allow-Origin: *`. |
| `chat.defaultChannel`, `chat.theme`, `chat.themeCss`, `chat.modules`, `chat.ctcpVersion`, `chat.defaultQuitMessage` | no | As for the [desktop app](desktop.md#editionjson). |
| `texts` | no | Texts that replace bundled ones, per language: `{ "de": { "key": "Text" } }`. Keys of the chat (`src/i18n/`) and of the shell (`mobile/locales/`). |
| `push` | no | `googleServices`: the `google-services.json` of your Firebase project. Its Android app must have `appId` as package name, the build checks that. A file named `google-services.json` in the edition folder is used without this entry. Without the file the app has no push. |

All file paths are relative to the edition folder and must stay inside it. The full schema is `mobile/edition.schema.json`.

## Connections

Like in the desktop app, every connection is a profile: the primary server of the edition or any other server, over TCP (with or without TLS) or a secure WebSocket. The chat on screen runs one connection; the icon at the top of its channel drawer opens the list of connections, where the user switches between them or opens Settings, Connections to add, edit and delete them. Switching closes the connection on screen. Push keeps notifying for every connection that has it on.

Passwords and API tokens are encrypted with a key in the Android Keystore and only go to the server they were stored for: changing the address of a connection drops them. A backup restored on another device cannot decrypt them, the user signs in again.

## Push notifications

The IRC server sends Web Push (`draft/webpush`) for the connection. Apps cannot receive Web Push directly, so the network relays it to Firebase Cloud Messaging, see the feature [`push`](features.md#push). The app creates its own Web Push keys per connection and decrypts the pushes itself; a push is matched to its connection by the keys that decrypt it.

A network can only relay to apps of the Firebase project whose service account it holds. Push therefore works where the network relays for your edition's project, typically your own network.

## Releases

1. Raise the version in `mobile/package.json` (or set `STARCHAT_VERSION`). `1.2.3` becomes versionCode `10203`; Google Play takes every versionCode once.
2. Create an upload key once and keep it out of the repository:

   ```
   keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
   ```

   and `mobile/android/keystore.properties` (not in git):

   ```properties
   storeFile=C:/keys/upload.jks
   storePassword=...
   keyAlias=upload
   keyPassword=...
   ```

3. `npm run aab` and upload `mobile/dist/<appId>-<version>.aab` in the Play Console.
