# Features

StarChat works on every IRC network with WebSocket. Some functions need more from the network: an IRCv3 capability of the IRC server, or a service the network offers through its [discovery file](discovery.md) and API. This page lists what the user gets in each case and what the network has to provide.

## On every network

These work without a discovery file, as long as the IRC server offers the capability where one is named. See [IRCv3 support](ircv3.md) for the full list.

- Channels, direct messages, nick list, topics and modes, channel list (`LIST`) with search
- Login with account and password (SASL `PLAIN`) or as a guest
- History when opening a channel and scrolling up (`chathistory`)
- Reactions, replies and typing indicators (`message-tags`)
- Deleting own messages (`draft/message-redaction`), multiline messages (`draft/multiline`)
- Read position shared by all sessions of an account (`draft/read-marker`)
- Avatars and status set by other clients (`draft/metadata-3` or `draft/metadata-2`)
- Browser push notifications for logged-in accounts (`draft/webpush`, needs the [`pushWorker`](options.md#push-notifications) option)
- Highlight words, ignore list, quit message, nick colors, autojoin, drafts, message search, [commands and shortcuts](commands.md)
- Light and dark theme, English and German

## With a discovery file

A network that serves `/.well-known/starchat.json` can set its name, WebSocket address, logo and theme, and link pages of its website:

| Discovery entry | What the user gets |
|-----------------|--------------------|
| `links.register` | "Create account" link in the login dialog. |
| `links.channelInvite` | "Copy invite link" in the channel menu. |
| `links.reportPolicy` | Link to the rules in the report dialog. |
| `links.communityInvite` | "Copy invite link" for a community (feature `communities`). |
| `auth: ["bearer"]` | One login for IRC and the API: the client gets a token from the API and logs in with SASL `IRCV3BEARER`. |

## With an API

Features below need `apiBaseUrl` and the feature name in `features`. Most also need a token, so guests do not see them. The endpoints of each feature are in the [API reference](openapi.yaml), how to set them up is described [below](#setting-up-the-features).

| Feature | What the user gets | Token |
|---------|--------------------|-------|
| `profiles` | Profile cards with avatar, status and member date. Own avatar and status can be changed in the settings. | yes |
| `friends` | Friend list and requests, a friends section in the sidebar with online state, requests from the profile card. | yes |
| `uploads` | Images and files in messages: paste, drop or pick, with progress. | yes |
| `gifs` | GIF search in the message input. | no |
| `reports` | Reporting users and messages to the network's moderators. Guests may report. | no |
| `explore` | A directory tab in the channel list: groups of channels the network lists, joined together. | no |
| `chatState` | Open conversations and settings synced across devices. | yes |
| `alwaysOn` | Staying in channels while no client is connected. The client asks once after the first login. | yes |
| `events` | A calendar button in the sidebar with upcoming events, linked to their channels. | yes |
| `communities` | An icon per community in the rail. Picking one shows its channels and opens its lobby, Home groups the joined channels by community. With `links.communityInvite` a "Copy invite link" button. | yes |
| `push` | Push notifications in app builds, relayed by the network to Firebase Cloud Messaging. Browsers do not need it. | yes |
| `voice` | Voice chat per channel. Push to talk or voice activation, mic test, volume per participant, optional noise filter. Needs a [LiveKit](https://livekit.io) server. | yes |
| `calls` | Voice calls between friends from the direct message window. Needs `voice` and `friends`. | yes |
| `spotify` | Desktop app: the track playing on the linked Spotify account becomes the now-playing status. | yes |

## Client only

| Module | What it does |
|--------|--------------|
| `share` | Receives text, links and files shared to an app build and offers to send them. |

A page can leave out modules it does not want with the `modules` option of [`mountChat()`](options.md). A feature is only active when its module is loaded and the network offers it.

## Setting up the features

The examples use [Ergo](https://ergo.chat) as IRC server. The API can be written in any language. It only has to answer the requests in the [API reference](openapi.yaml) and send CORS headers (see [API](discovery.md#api)). Start with a discovery file that lists only what is there, and add features one by one:

```json
{
  "schemaVersion": 1,
  "name": "Example Net",
  "websocketUrl": "wss://irc.example.org/webirc",
  "apiBaseUrl": "https://example.org/api",
  "auth": ["bearer", "guest"],
  "features": ["profiles", "friends"]
}
```

### One login for IRC and the API

With `bearer` in `auth` the user logs in once and the same token works on IRC and in the API. The API checks name and password in [`POST login`](openapi.yaml#login) and answers with a JWT. Ergo checks the JWT itself, the account name comes from a claim:

```yaml
accounts:
    jwt-auth:
        enabled: true
        # create the IRC account on the first login with a valid token
        autocreate: true
        tokens:
            -
                algorithm: "hmac"
                key: "<long random secret, the API signs with the same one>"
                account-claims: ["sub"]
```

The token is signed with HS256, with the account name in `sub` and an expiry in `exp`. The client does not renew tokens. When one expires, the login fails and the user logs in again, so pick a lifetime that fits your network (days rather than minutes). The API checks the same signature for `Authorization: Bearer`.

A website that already has logged-in users can hand them a token directly, see [Embedding with login](embedding.md).

### `profiles`

The network stores avatar and status per account and links further settings with `settings_url`. Avatars are only shown when their URL is on the same origin as `apiBaseUrl`, so serve them from there. The client also publishes avatar and status as IRCv3 metadata, which Ergo allows by default (`metadata.enabled`).

### `friends`

Friendships are stored per account in the network's database, IRC knows nothing about them. Online state comes from IRC (`MONITOR`, which Ergo supports). The client polls the list every 10 seconds, so keep `GET friends` cheap.

### `uploads`

The network stores the files and serves them from a public `https` URL with the right `Content-Type`. Answer files that are too large with `413`. Uploads are public links, so the network decides how long they stay.

### `gifs`

The API forwards the search to a GIF service. The service's API key stays on the server, and when the API also proxies the images, the service does not see the users' addresses. Fill `provider` with the name and link the service asks to show.

### `reports`

Reports are stored and shown to the moderators, for example on an admin page or as a message in a staff channel. Limit them per address or account and answer with `429` above the limit. Link your rules with `links.reportPolicy`.

### `explore`

A list of channel groups from the network's website, for example the communities a site lists publicly. No token is needed, guests see the directory too.

### `chatState`

One JSON document per account. `POST chat-state` replaces the lists and merges `settings_patch` into the stored settings: a key with `null` is removed, keys the server does not know are kept.

### `alwaysOn`

Ergo keeps always-on clients connected while the user is away. Let users opt in:

```yaml
accounts:
    multiclient:
        enabled: true
        always-on: "opt-in"
        auto-away: "opt-in"
```

The API changes the setting through Ergo's HTTP API (Ergo 2.19 or newer for `saget` and `saset`). Enable it on localhost only:

```yaml
api:
    enabled: true
    listener: "127.0.0.1:8089"
    bearer-tokens:
        - "<long random token for the network's API>"
```

`GET chat/always-on` reads the setting with `POST /v1/ns/saget` (`{"accountName": "alice"}`, answer field `alwaysOn`). `PUT chat/always-on` sets it with `POST /v1/ns/saset` (`{"accountName": "alice", "alwaysOn": "on", "autoAway": "on"}`). With `autoAway` the user shows as away while no client is connected. The network also stores whether the user answered the question, which gives `ask`. Answer with `503` when Ergo cannot be reached.

### `events`

Events are planned on the network's website. The API expands recurring events into single dates (for example the next 30 days, at most 20) and filters by `community` when the client asks for one.

### `communities`

Groups of channels managed on the network's website. `GET my-communities` returns the groups the user belongs to. Register the channels on IRC, so the group's owners keep control of them. With `slug` and `links.communityInvite` users can share an invite page of the group.

### `push`

Browsers get push notifications from Ergo directly (`draft/webpush`). App builds cannot receive Web Push, so the network relays it to Firebase Cloud Messaging (FCM). Enable Web Push in Ergo:

```yaml
webpush:
    enabled: true
    subscriber: "https://example.org/"
```

How a push reaches an app:

1. The app gets an FCM token and creates its own Web Push keys. The chat sends the FCM token to [`POST chat/push-devices`](openapi.yaml#push).
2. The network stores the token and answers with an endpoint URL that is unique and hard to guess, for example `https://example.org/push/<random>`.
3. The chat registers this endpoint and the app's keys with Ergo (`WEBPUSH REGISTER`).
4. Ergo sends encrypted pushes (`Content-Encoding: aes128gcm`, at most 4096 bytes) to the endpoint. The network does not decrypt them. It sends the body base64 encoded as FCM data message `{ "webpush": "<body>" }` to the token and answers `201`.
5. The app decrypts the push with its keys and shows it.

The endpoint needs no login, the URL itself is the secret. It answers `404` for unknown endpoints and `410` when FCM reports the token as unregistered, so Ergo drops the subscription.

App and chat talk through `onHostMessage` and methods of the chat component:

| Direction | Message | Meaning |
|-----------|---------|---------|
| chat → app | `push-subscribe` | Asks for `{ fcmToken, p256dh, auth }`. |
| app → chat | `receivePushSubscription(data)` | The answer, or `{ error }`. Without answer after 15 seconds the attempt fails. |
| chat → app | `push-filter` | `{ muted, ignored }`: channels and nicks whose pushes the app drops. |
| chat → app | `push-unsubscribe` | Logout, the app deletes its keys. |
| app → chat | `openPushTarget(target)` | A tapped notification: channel or nick to open. |

### `voice`

Voice chat runs on a self-hosted [LiveKit](https://livekit.io) server. Create a key pair with `docker run --rm livekit/livekit-server generate-keys` and a config:

```yaml
port: 7880
rtc:
  tcp_port: 7881          # fallback when UDP is blocked
  udp_port: 7882          # all audio over one UDP port
  use_external_ip: true
keys:
  <API key>: "<API secret>"
room:
  empty_timeout: 300
  max_participants: 50
```

Put the signalling port 7880 behind a reverse proxy with TLS (`wss://voice.example.org`). The audio ports 7881/tcp and 7882/udp go directly to LiveKit, not through the proxy. Users behind strict firewalls also need LiveKit's TURN server (`turn` in the config). LiveKit's [connection test](https://livekit.io/connection-test) shows what is reachable.

[`POST chat/voice/token`](openapi.yaml#voice) checks that the nick belongs to the account of the token and is in the channel. With Ergo's HTTP API (see [`alwaysOn`](#alwayson)), `POST /v1/whois` with `{"nickname": "alice"}` returns `account` and `channels`. Then the API issues a LiveKit access token with the LiveKit server SDK of its language:

- Room: one per channel, for example `irc:#bridge`.
- Identity: the account name. Name: the nick.
- Grants: join, publish and subscribe. Room admin for channel operators (`mode` in `channels`), also returned as `is_moderator`.
- Lifetime: a few minutes. The token is only needed to join, a running call stays up.

Who is in a voice chat is published as metadata `voice`, which Ergo allows by default.

For the RNNoise filter in the voice settings, host the WebAssembly files of [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1 (`rnnoise.wasm`, `rnnoise_simd.wasm`) with `Content-Type: application/wasm` and `Access-Control-Allow-Origin: *`, and list them in `GET chat/voice/filters`.

### `calls`

Calls use the LiveKit server of `voice`. [`POST chat/voice/call-token`](openapi.yaml#calls) checks that both accounts are friends and returns a token for a room both sides get the same way, for example `dm:` plus both account names in lower case and sorted. Ringing runs over IRC (see [IRCv3 support](ircv3.md#client-tags)).

`POST chat/voice/call-ring` is optional and rings app builds in the background. With the push relay above, the network sends an FCM data message with `call` (`invite` or `cancel`), `call_id`, `nick` and `account` to the friend's installs and returns how many it reached. A network without app builds answers `{ "pushed": 0 }`.

Users can switch private calls off in the voice settings. Their chat then answers every invite with `unavailable` and hides the call button, and the Android app drops call pushes in the background.

An app build that receives the ring opens the chat with `openPushTarget('call:id=…&nick=…&account=…&answer=accept|decline')` (`answer` optional, without it the chat rings). In the background a browser or desktop chat shows a system notification and sends `call-incoming` with `{ nick }` to `onHostMessage`, so a desktop shell can flash its window.

### `spotify`

Register an app in the Spotify developer dashboard with the redirect URL of your API. `GET spotify/auth-url` returns the authorization link (scope `user-read-currently-playing`) with a one-time `state` tied to the account. The callback stores the refresh token. `GET spotify/current-track` asks Spotify for the playing track with a fresh access token and returns title and artist.
