# Features

StarChat works on every IRC network with WebSocket. Some functions need more: an IRCv3 capability of the server, or a service the network offers through its [discovery file](discovery.md) and API.

## On every network

Where a capability is named, the server has to offer it. See [IRCv3 support](ircv3.md).

- Channels, direct messages, nick list, topics, modes, channel list with search
- Login with account (SASL `PLAIN`) or as a guest
- History (`chathistory`)
- Reactions, replies, typing indicators (`message-tags`)
- Deleting own messages (`draft/message-redaction`), multiline messages (`draft/multiline`)
- Read position shared across sessions (`draft/read-marker`)
- Avatars and status from other clients (`draft/metadata-3`)
- Browser push for logged-in accounts (`draft/webpush`, needs the [`pushWorker`](options.md#push-notifications) option)
- Highlights, ignore list, nick colors, autojoin, drafts, search, [commands and shortcuts](commands.md)
- Light and dark theme, English and German

## With a discovery file

The file sets name, WebSocket address, logo and theme, and can link pages of the network's website:

| Entry | What the user gets |
|-------|--------------------|
| `links.register` | "Create account" in the login dialog |
| `links.channelInvite` | "Copy invite link" in the channel menu |
| `links.reportPolicy` | Link to the rules in the report dialog |
| `links.communityInvite` | "Copy invite link" for a community |
| `auth: ["bearer"]` | One login for IRC and the API |

## With an API

These need `apiBaseUrl` and the feature in `features`. Features with a token are hidden until the user has one, so also for guests and for logins without `bearer` or `api-login`. Endpoints are in the [API reference](openapi.yaml).

| Feature | What the user gets | Token |
|---------|--------------------|-------|
| `profiles` | Profile cards with avatar and status, editable in the settings | yes |
| `friends` | Friend list with online state and requests | yes |
| `uploads` | Images and files in messages | yes |
| `gifs` | GIF search | no |
| `reports` | Reporting users and messages to moderators | no |
| `explore` | A directory of channel groups in the channel list | no |
| `chatState` | Open conversations and settings synced across devices | yes |
| `alwaysOn` | Staying in channels while no client is connected | yes |
| `events` | Upcoming events, linked to their channels | yes |
| `communities` | Groups of channels with their own view in the sidebar | yes |
| `push` | Push notifications in the apps (browsers do not need it) | yes |
| `voice` | Voice chat per channel, needs [LiveKit](https://livekit.io) | yes |
| `calls` | Voice calls between friends, needs `voice` and `friends` | yes |
| `spotify` | Desktop app: the playing Spotify track as status | yes |

A page can leave out features with the `modules` option of [`mountChat()`](options.md). A feature is active when its module is loaded and the network offers it.

## Setting up the features

The examples use [Ergo](https://ergo.chat). The API can be written in any language, it has to answer the requests in the [API reference](openapi.yaml) and send CORS headers (see [API](discovery.md#api)). Start with a discovery file that lists only what is there:

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

With `bearer` in `auth`, [`POST login`](openapi.yaml#login) checks name and password and returns a JWT that works on IRC and in the API. Ergo checks it itself:

```yaml
accounts:
    jwt-auth:
        enabled: true
        autocreate: true
        tokens:
            -
                algorithm: "hmac"
                key: "<secret the API signs with>"
                account-claims: ["sub"]
```

HS256, account name in `sub`, expiry in `exp`. The client does not renew tokens, so use days rather than minutes. A site with logged-in users can hand out tokens itself, see [Embedding with login](embedding.md).

### Login without tokens on IRC

If the IRC server cannot check tokens, for example with Anope, use `api-login` instead of `bearer`. The client sends name and password to `POST login` for an API token and logs in on IRC with SASL `PLAIN` as before. The token is only for the API, so it can be any string your API recognizes. The API has to check passwords against the same accounts as the IRC services. Anope, for example, can keep its accounts in MySQL, where the API can read them. If the API refuses or is down, the user still gets into IRC, just without the features that need a token.

### `profiles`

Avatar and status are stored per account. Avatars are only shown from the origin of `apiBaseUrl`.

### `friends`

Friendships live in the network's database. Online state comes from IRC (`MONITOR`). The client polls `GET friends` every 10 seconds, so keep it cheap.

### `uploads`

Files are served from a public `https` URL with the right `Content-Type`. Answer `413` when a file is too large.

### `gifs`

The API forwards the search to a GIF service, so its key stays on the server. Put the name and link the service asks for into `provider`.

### `reports`

Show reports to your moderators, for example in a staff channel. Answer `429` above your limit.

### `chatState`

One JSON document per account. `POST chat-state` replaces the lists and merges `settings_patch` into the settings (`null` removes a key).

### `alwaysOn`

Let users opt in to Ergo's always-on:

```yaml
accounts:
    multiclient:
        enabled: true
        always-on: "opt-in"
        auto-away: "opt-in"
```

The API changes it through Ergo's HTTP API (Ergo 2.19 or newer), on localhost only:

```yaml
api:
    enabled: true
    listener: "127.0.0.1:8089"
    bearer-tokens:
        - "<token for the network's API>"
```

`GET chat/always-on` uses `POST /v1/ns/saget`, `PUT chat/always-on` uses `POST /v1/ns/saset` with `alwaysOn` and `autoAway`. Answer `503` when Ergo cannot be reached.

### `events` and `communities`

Both come from the network's website. Recurring events are expanded into single dates by the API. Register community channels on IRC so their owners keep control.

### `push`

Browsers get push from Ergo directly (`draft/webpush`). Apps cannot receive Web Push, so the network relays it to Firebase Cloud Messaging:

```yaml
webpush:
    enabled: true
    subscriber: "https://example.org/"
```

1. The app sends its FCM token to [`POST chat/push-devices`](openapi.yaml#push).
2. The network answers with an endpoint URL that is hard to guess, for example `https://example.org/push/<random>`.
3. The chat registers this endpoint with Ergo (`WEBPUSH REGISTER`).
4. Ergo sends encrypted pushes to the endpoint. The network forwards the body base64 encoded as FCM data message `{ "webpush": "<body>" }` and answers `201`.
5. The app decrypts and shows it.

The endpoint needs no login. It answers `404` for unknown endpoints and `410` when FCM reports the token as gone. FCM only accepts the network's relay for apps of the Firebase project it holds the key for, see [Mobile app](mobile.md#push-notifications).

### `voice`

Voice runs on a self-hosted [LiveKit](https://livekit.io) server:

```yaml
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
keys:
  <API key>: "<API secret>"
```

Put port 7880 behind a TLS proxy (`wss://voice.example.org`). 7881/tcp and 7882/udp go directly to LiveKit.

[`POST chat/voice/token`](openapi.yaml#voice) checks that the nick belongs to the account and is in the channel (Ergo: `POST /v1/whois`), then issues a LiveKit token: one room per channel, the account as identity, room admin for channel operators, a lifetime of a few minutes.

For the noise filter, host `rnnoise.wasm` and `rnnoise_simd.wasm` from [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1 with `Access-Control-Allow-Origin: *` and list them in `GET chat/voice/filters`.

### `calls`

[`POST chat/voice/call-token`](openapi.yaml#calls) checks that both are friends and returns a token for a room both sides name the same way, for example `dm:` plus both accounts sorted. Ringing runs over IRC (see [client tags](ircv3.md#client-tags)). `POST chat/voice/call-ring` is optional and rings the apps through the push relay. Without apps, answer `{ "pushed": 0 }`.

### `spotify`

Register an app with Spotify. `GET spotify/auth-url` returns the login link (scope `user-read-currently-playing`), `GET spotify/current-track` returns title and artist.
