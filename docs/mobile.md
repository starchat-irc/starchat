# Mobile app

The Android app lives in `mobile/`. It is a Capacitor shell around the chat, like the [desktop app](desktop.md) is an Electron shell. IRC over TCP, the encrypted store for passwords, push and sharing are native code in `mobile/android/`. iOS may follow.

## Building

You need JDK 21, the Android SDK and Node.js 22. Paths that are not in the environment go into `mobile/build.local.json` (not in git):

```json
{
    "javaHome": "C:/Java/jdk-21",
    "androidHome": "C:/Android/Sdk"
}
```

```
npm install
cd mobile
npm install
npm run apk          # debug APK in mobile/dist/
npm run aab          # signed App Bundle for Google Play
npm test
npm run test:android # Java unit tests, after a build
```

`--dev` builds a development app with the id `devAppId` and the name "StarChat Dev", so it installs next to the released one:

```
STARCHAT_VERSION=0.0.0-dev.7 node scripts/build.mjs apk-release --dev
```

`.github/workflows/android.yml` does this on every push to `main` and attaches `starchat-android-dev.apk` to the pre-release `latest-dev`. Repository secrets:

| Secret | Content |
|--------|---------|
| `ANDROID_KEYSTORE` | Signing key for development builds, `base64 -w0 dev.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Its password (same for key and store) |
| `GOOGLE_SERVICES_JSON` | Optional, `google-services.json` with `appId` and `devAppId`. Without it there is no push. |

Without `ANDROID_KEYSTORE` the workflow builds nothing, so forks stay green. A fork picks its edition with the variable `STARCHAT_MOBILE_EDITION`.

## Editions

As for the [desktop app](desktop.md#editions), name, id, icons and servers come from an edition. `mobile/edition/` builds StarChat. For your own app:

```
node scripts/build.mjs apk --edition ../my-edition
```

```json
{
    "$schema": "../edition.schema.json",
    "appName": "Example Chat",
    "appId": "org.example.chat",
    "icon": "icon.png",
    "adaptiveIcon": { "foreground": "icon-foreground.png", "background": "#20232a" },
    "chat": { "primaryServer": "irc.example.org", "defaultChannel": "#lobby" },
    "push": { "googleServices": "google-services.json" }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `appName` | yes | Name under the icon, at most 30 characters. |
| `appId` | yes | Android application id. Never change it after the first release. |
| `devAppId` | no | Id of `--dev` builds, `appId` plus `.dev` by default. |
| `icon` | yes | Square PNG, at least 512x512. |
| `adaptiveIcon` | no | `foreground` (transparent PNG of at least 432x432 or a vector `.xml`, motif in the middle 66 percent) and `background` (`#rrggbb`). |
| `splashBackground` | no | Colour of the start screen. |
| `chat.*` | no | As in the [desktop edition](desktop.md#editionjson). |
| `texts` | no | Replaced texts per language, keys from `src/i18n/` and `mobile/locales/`. |
| `push` | no | `googleServices`: `google-services.json` of your Firebase project, with `appId` as package name. `gateway`: URL of a [push gateway](https://github.com/starchat-irc/push-gateway) for that project. |

Paths are relative to the edition folder. The schema is `mobile/edition.schema.json`.

## Connections

Every connection is a profile, over TCP, TLS or WebSocket. The icon at the top of the channel drawer switches between them. Passwords and tokens are encrypted with the Android Keystore and only go to the server they were stored for. After restoring a backup on another device the user signs in again.

## Push notifications

The IRC server sends Web Push, the network relays it to FCM (feature [`push`](features.md#push)) and the app decrypts it with its own keys. When the user reads a conversation elsewhere, the notification goes away.

FCM only delivers to apps of the Firebase project whose key the sender holds. So a network's relay only helps the apps it was set up for, usually its own. An edition with `push.gateway` uses its gateway on every network with `draft/webpush`.

## Releases

The version comes from `mobile/package.json` or `STARCHAT_VERSION`. `1.2.3` becomes versionCode `10203`.

Locally, put the upload key into `mobile/android/keystore.properties` (not in git):

```properties
storeFile=C:/keys/upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

and run `npm run aab`.

On a tag `v*`, `android.yml` builds the bundle and attaches it to the release as `starchat-android-<version>-play.aab`, for upload in the Play Console. The upload key lives in the GitHub environment `play`, which only tags `v*` may use:

| Secret | Content |
|--------|---------|
| `ANDROID_UPLOAD_KEYSTORE` | `base64 -w0 upload.jks` |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Its password |

With Play App Signing, Google keeps the signing key. If the upload key gets lost, Google can reset it.
