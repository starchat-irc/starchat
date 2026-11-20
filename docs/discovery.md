# Discovery file

A network can tell StarChat its WebSocket address and the extra services it offers with a small JSON file on its own domain, at this address:

```
https://<domain>/.well-known/starchat.json
```

`<domain>` is the `domain` of the network in [`servers/servers.json`](../servers/servers.json), or the domain a user typed in. Networks without this file work as plain IRC servers. The file is optional, and so is every field except `schemaVersion`.

Example: [`discovery.example.json`](discovery.example.json). Schema: [`discovery.schema.json`](discovery.schema.json).

## Where the file is looked up

These rules are about the file itself. The addresses inside it (API, WebSocket, logo, links) may be on any domain, see [Fields](#fields).

- Always over `https`. The client sends no cookies with the request.
- Redirects are followed only within the domain or its subdomains (`example.org` to `www.example.org`), not to another domain.
- A list entry may point to another location with `discovery`, but only on the same domain or a subdomain of it. Otherwise an entry for a foreign network could hand out its own API and collect its logins.
- Serve it with `Access-Control-Allow-Origin: *`, otherwise the web build cannot read it.

## Fields

| Field | Type | Meaning |
|-------|------|---------|
| `schemaVersion` | `1` | Required. Clients ignore files with a version they do not know. |
| `name` | string, max. 60 | Display name of the network. Overrides the name from the server list. |
| `websocketUrl` | `wss://` URL | IRC over WebSocket. Overrides the entry in the server list. |
| `apiBaseUrl` | `https://` URL | Base URL of the API for the features below. Without it no feature is used. |
| `auth` | array | Login methods the network accepts, see below. |
| `features` | array | Extra services, see below. Requires `apiBaseUrl`. |
| `branding.logo` | `https://` URL | Logo shown for this network. |
| `branding.themeCss` | `https://` URL | Stylesheet with the theme variables of the network. |
| `links` | object | Pages of the network, see below. Works without `apiBaseUrl`. |

Endpoints may be on other domains than the network itself, for example an API on `api.example.net` or a WebSocket on a separate host. They must use `https` or `wss`. Plain `http` and `ws` are dropped. The file is trusted for these addresses because it was loaded from the network's own domain.

Unknown fields and unknown values in `auth` and `features` are ignored, so a file written for a newer client still works with an older one. New fields and values are added to this document first.

## Links

Pages on the network's website that the client links to. All `https`, others are dropped.

| Field | Meaning |
|-------|---------|
| `links.register` | Creating an account. Linked in the login dialog. |
| `links.channelInvite` | Invite link of a channel. Must contain `{channel}`, which is replaced by the channel name without `#`, URL encoded (`https://example.org/join/{channel}`). The channel menu then offers "Copy invite link". |
| `links.reportPolicy` | Rules for reports, linked in the report dialog (feature `reports`). |
| `links.communityInvite` | Invite page of a community. Must contain `{community}`, which is replaced by the community's `slug`, URL encoded (`https://example.org/invite/{community}`). Feature `communities` then offers "Copy invite link" for the community shown. |

## Login methods (`auth`)

| Value | Meaning |
|-------|---------|
| `sasl-plain` | Account name and password, sent over SASL `PLAIN` on the IRC connection. |
| `bearer` | The client gets a token from the API and logs in with SASL `IRCV3BEARER`. |
| `guest` | Connecting without an account is allowed. |

Without `auth` the client assumes `sasl-plain` and `guest`, like any IRC server. With `bearer` the client gets its token as described under [API](#api).

## Features

Every connection has its own features and its own token. A token is only sent to the `apiBaseUrl` of the network it belongs to.

| Value | Service |
|-------|---------|
| `profiles` | Profile cards, avatars and status. |
| `friends` | Friend list and requests. |
| `uploads` | File and image uploads. |
| `push` | Push relay for app builds (FCM). Browser push works without it, see [Push notifications](options.md#push-notifications). |
| `voice` | Voice channels. |
| `calls` | Voice calls between friends. |
| `reports` | Reporting users and messages. |
| `explore` | Directory of channels and communities. |
| `chatState` | Open conversations and read markers synced across devices. |
| `alwaysOn` | Staying connected while the client is closed (bouncer). |
| `events` | Community events in the chat. |
| `gifs` | GIF search in the message input. |
| `communities` | Groups of channels the user belongs to, with their own view in the sidebar. |
| `spotify` | The track playing on the user's linked Spotify account as now-playing status (desktop app). |

## API

All paths are relative to `apiBaseUrl`. Requests and answers are JSON unless noted. The client sends `Accept: application/json` and no cookies, so the API has to answer cross-origin requests (`Access-Control-Allow-Origin: *` or the calling origin, `Authorization` as allowed header).

### Token

The token is a string the IRC server accepts with SASL `IRCV3BEARER` and the API accepts as `Authorization: Bearer <token>`. With [Ergo](https://ergo.chat) this is a JWT signed with a key from `accounts.jwt-auth`, the account name in `sub`.

A client gets a token in one of two ways:

- From the page that embeds the chat (`mountChat({ bearer })`, see the README).
- With `bearer` in `auth`, from the login form:

```
POST login
{ "username": "alice", "password": "secret" }
```

| Status | Answer |
|--------|--------|
| `200` | `{ "token": "…", "nickname": "alice" }`. `nickname` is optional, the client then keeps the one typed in. |
| `401` | Wrong name or password. |

The client then logs in on IRC with `IRCV3BEARER` instead of `PLAIN`. Without `bearer` in `auth` a password goes to the IRC server with SASL `PLAIN` and the client has no token, so features that need one stay hidden. Guests have no token either.

An API request with a missing or expired token is answered with `401`.

### `profiles`

Needs a token.

| Request | Answer |
|---------|--------|
| `GET chat/profiles/{account}` | Profile of an IRC account (`330` in WHOIS), `404` if there is none. |
| `GET chat/profile` | Own profile. Also loaded after every connect to publish avatar and status. |
| `PUT chat/profile/status` | Body `{ "status": "…" }` or `{ "status": null }`, max. 128 characters. Answer `{ "status": "…" }`. |
| `POST chat/profile/avatar` | `multipart/form-data` with the image in `avatar` (JPEG, PNG or GIF, max. 2 MB). Answer `{ "avatar_url": "…" }`. |
| `DELETE chat/profile/avatar` | Answer `{ "avatar_url": null }`. |

A profile:

| Field | Type | Meaning |
|-------|------|---------|
| `name` | string | Account name. |
| `avatar_url` | `https://` URL or `null` | Shown only if it is on the same origin as `apiBaseUrl`. |
| `status` | string or `null` | Status text, one line. |
| `member_since` | ISO 8601 date or `null` | |
| `characters` | array, optional | `{ name, race, character_class, url }`, e.g. roleplay characters. |
| `mutual_communities` | array, optional | `{ name, slug }`, groups the viewer and this account both belong to. |
| `settings_url` | URL, optional | Own profile only: link to further account settings. |
| `delete_account_url` | URL, optional | Own profile only. |

Errors with `422` carry Laravel style messages (`{ "message": "…", "errors": { "avatar": ["…"] } }`), the client shows the first one.

Avatar and status are also published as IRCv3 metadata (`avatar`, `status`), so other clients see them without the API.

### `friends`

Needs a token. Requests go to account names. Presence comes from IRC (`MONITOR`, `JOIN`, `QUIT`, `AWAY`), not from the API.

| Request | Answer |
|---------|--------|
| `GET friends` | `{ "friends": [], "incoming_requests": [], "outgoing_requests": [], "blocked": [] }`, lists of entries as below. Polled every 10 seconds while the client is connected. |
| `POST friends/request` | Body `{ "nick": "bob" }`. A request to someone who already asked us accepts theirs, the answer then has `"auto_accepted": true`. |
| `POST friends/{friendship_id}/accept` | Accept an incoming request. |
| `POST friends/{friendship_id}/decline` | Decline an incoming request. |
| `POST friends/{friendship_id}/block` | Block the other side. |
| `DELETE friends/{friendship_id}` | End a friendship or withdraw an outgoing request. |

An entry:

| Field | Type | Meaning |
|-------|------|---------|
| `friendship_id` | string or number | Used in the paths above. |
| `user.display` | string | Nick of the other side on IRC. Entries without it are ignored. |
| `user.name` | string, optional | Account name. |
| `status` | string, optional | `accepted`, `pending` or `blocked`. |
| `direction` | string, optional | `incoming` or `outgoing`. |
| `requested_at` | ISO 8601 date, optional | |

The client shows its own texts after an action. Errors with `422` carry Laravel style messages, the client shows the first one.

### `uploads`

Needs a token. Images and videos from the file picker, paste or drop are uploaded when the message is sent, the message then carries the link. Links ending in an image or video extension are shown inline, for every user and client.

| Request | Answer |
|---------|--------|
| `POST chat/media-upload` | `multipart/form-data` with the file in `media` and the message text in `caption` (optional). Answer `{ "id": …, "url": "https://…" }`. |
| `GET chat/media-upload` | `{ "uploads": [] }`, own uploads, newest first. |
| `DELETE chat/media-upload/{id}` | Delete an own upload. |

An upload in the list:

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string or number | Used in the path above. |
| `url` | URL | Public link to the file. |
| `mime_type` | string | Images and videos get a preview. |
| `original_name` | string, optional | |
| `caption` | string or `null`, optional | |

Errors: `413` file too large, `422` with Laravel style messages (the client shows the first one).

### `gifs`

The token is sent if there is one. A server that wants to limit guests answers them with `401`.

```
GET gifs/search?limit=20&q=cats&page=2
```

Without `q` the server returns trending GIFs. `page` is the `next` value of the previous answer.

```json
{
  "results": [{ "id": "abc", "title": "Cat", "url": "https://…/abc.gif", "preview": "https://…/abc.webp" }],
  "next": 2,
  "provider": { "name": "GIF service", "url": "https://…" }
}
```

`url` is sent as the message, `preview` is shown in the picker. Results without `https` URLs are dropped. `next` is `null` on the last page. `provider` is optional and shown as "Powered by" under the results, as most GIF services require.

### `reports`

Guests may report too, the token is sent if there is one. A report goes to the moderators of the network.

```
POST chat/reports
```

| Field | Type | Meaning |
|-------|------|---------|
| `reported_nick` | string | Nick of the reported user. |
| `reported_account` | string or `null` | Account from WHOIS, if the profile card was open. |
| `reporter_nick` | string | Own nick, `Guest` if unknown. |
| `channel` | string or `null` | Channel the report was sent from, `null` in DMs. |
| `message_text` | string or `null` | Reported message, max. 2000 characters. |
| `message_sent_at` | ISO 8601 date or `null` | Time of the reported message. |
| `reason` | string | `child_safety`, `sexual_content`, `harassment`, `hate_speech`, `spam` or `other`. |
| `details` | string or `null` | Note of the reporter, max. 2000 characters. |

| Status | Meaning |
|--------|---------|
| `201` | Received. The client shows its own text. |
| `422` | Invalid fields. |
| `429` | Too many reports, the client asks to wait. |

### `explore`

No token needed. The channel list of the IRC server (`LIST`) is shown on every network, this feature adds a tab with the network's directory: groups of channels that are joined together.

```
GET explore
```

```json
{
  "communities": [
    { "id": 1, "name": "Starfleet", "description": "Roleplay on the bridge", "channel_names": ["#bridge", "#lounge"] }
  ]
}
```

`description` is optional. Channel names without `#` and groups without channels are dropped.

### `chatState`

Needs a token. Open conversations, read positions and the synced settings of an account, so another device (or the next session) continues where the last one stopped.

| Request | Answer |
|---------|--------|
| `GET chat-state` | The state below. An account without a saved state gets empty lists and `"settings": null`. |
| `POST chat-state` | Body: the state below, `settings_patch` instead of `settings`. Sent at most every 5 seconds, after changes. |

| Field | Type | Meaning |
|-------|------|---------|
| `open_dms` | array of strings | Nicks with an open DM. |
| `joined_channels` | array of strings | Channels to join on the next connect (each starting with `#`), without the default channel. |
| `active_channel` | string or `null` | Shown after the next connect. |
| `sidebar_mode` | string | `channels`, `friends` or `uploads`. |
| `last_read` | object | `{ target: ISO 8601 date }`, read position per channel or DM. Newer local values win. |
| `unread_counts` | object | `{ target: number }`. |
| `settings` | object or `null` | Synced settings, see below. `null`: the account never synced, the client uploads its own values. |
| `settings_patch` | object | Only in `POST`: the settings changed on this device. `null` as value removes a key. The server merges it into the stored document, so changes from another device are kept. |

Settings:

| Key | Type |
|-----|------|
| `highlight_words` | array of strings, max. 20 |
| `ignored_users` | array of nicks, max. 100 |
| `channel_notifications` | `{ channel: "mentions" \| "mute" }` |
| `quit_message` | string, one line, max. 200 characters. Missing: the client's default. |
| `nick_colors` | `{ nick: hue 0–359 }` |
| `left_lobbies` | array of channels the user left on purpose, they are not joined by default any more |
| `autojoin_channels` | array of channels joined on every connect, max. 50 |

Unknown keys are kept by the client and should be kept by the server, other clients may use them.

### `alwaysOn`

Needs a token. Keeps the nick in its channels while no client is connected, for example Ergo's `always-on`. After the first registration the client asks once per account whether to turn it on.

| Request | Answer |
|---------|--------|
| `GET chat/always-on` | `{ "enabled": false, "ask": true }`. `ask`: show the question (not answered yet). |
| `PUT chat/always-on` | Body `{ "enabled": true }`. Answer `{ "enabled": true, "ask": false }`. |
| `POST chat/always-on/dismiss` | "No, thanks": the server stops asking. |

`503` when the IRC server cannot be reached, the client then shows the switch disabled.

### `events`

Needs a token. Upcoming events for the calendar button in the channel sidebar. The button only shows when the list has an event that has not started yet, and is marked when one starts within 24 hours. The client loads the list after every registration and every 15 minutes.

```
GET chat/events
```

```json
{
  "events": [
    { "event_id": 4, "title": "Bridge meeting", "starts_at": "2026-11-20T19:00:00Z", "recurrence": "weekly", "channel": "#bridge", "community_name": "Starfleet" }
  ]
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `event_id` | string or number | Recurring events appear once per date with the same id. |
| `title` | string | |
| `starts_at` | ISO 8601 date | Shown in the local time zone. Entries without a valid date are dropped. |
| `recurrence` | string, optional | `none`, `weekly`, `biweekly` or `monthly`, shown as a hint. |
| `channel` | string or `null`, optional | Channel of the event (starting with `#`), opened or joined from the list. |
| `community_name` | string, optional | Group the event belongs to, shown next to it. |

The server expands recurring events into single dates and decides how far ahead the list goes. With the `communities` feature the client asks for `chat/events?community=<id>` while a community is shown, and the name of the community is then left out.

### `push`

Needs a token. Only used by app builds (`shell: 'mobile'`): the app cannot receive Web Push itself, so the network relays it to Firebase Cloud Messaging. Browsers register directly with the IRC server and do not call these endpoints.

| Request | Answer |
|---------|--------|
| `POST chat/push-devices` | Body `{ "fcm_token": "…" }`. Answer `{ "endpoint": "https://…" }` (`201` new, `200` known). |
| `DELETE chat/push-devices` | Body `{ "fcm_token": "…" }`. Answer `204`. Sent on logout. |

The client hands the endpoint to the IRC server with `WEBPUSH REGISTER <endpoint> p256dh=…;auth=…`, using the keys the app created. The IRC server then sends encrypted pushes to the endpoint, the network forwards them unchanged to FCM and the app decrypts them. A token belongs to one install: registering it again moves it to the current account.

App and chat talk through `onHostMessage` and methods of the chat component:

| Direction | Message | Meaning |
|-----------|---------|---------|
| chat → app | `push-subscribe` | Asks for `{ fcmToken, p256dh, auth }`. |
| app → chat | `receivePushSubscription(data)` | The answer, or `{ error }`. Without answer after 15 seconds the attempt fails. |
| chat → app | `push-filter` | `{ muted, ignored }`: channels and nicks whose pushes the app drops. |
| chat → app | `push-unsubscribe` | Logout, the app deletes its keys. |
| app → chat | `openPushTarget(target)` | A tapped notification: channel or nick to open. |

### `voice`

Needs a token. Voice chat per channel through a [LiveKit](https://livekit.io) server of the network. The user switches it on under Settings → Voice chat (experimental, off by default). Who is in a voice chat is published as IRC metadata `voice` (value: the channel), so the nick list shows a speaker icon. Leaving the channel on IRC also leaves its voice chat.

```
POST chat/voice/token
```

Body `{ "channel": "#bridge", "nick": "alice" }`. The server checks that the nick belongs to the account of the token and is in the channel, for example with a WHOIS through the IRC server's API. Answer:

```json
{ "url": "wss://voice.example.org", "token": "…", "is_moderator": false }
```

| Field | Type | Meaning |
|-------|------|---------|
| `url` | URL | LiveKit server. |
| `token` | string | LiveKit access token for the room. The participant identity should be the account name, the participant name the nick. |
| `is_moderator` | boolean, optional | Channel operator: room admin in LiveKit. |

Refusals have a status and a `reason`, the client shows its own text for each:

| Status | `reason` | Meaning |
|--------|----------|---------|
| `403` | `not_allowed` | Voice is not enabled for this account (for example while testing). |
| `403` | `wrong_account` | The nick belongs to another account. |
| `403` | `not_in_channel` | The nick is not in the channel. |
| `503` | `whois_failed` | The nick could not be checked right now. |
| `404` | | Voice is not set up on this server. |

```
GET chat/voice/filters
```

Optional microphone filters (noise suppression) the client can load. The client ships the AudioWorklet of each filter it knows, the server hosts the WebAssembly files. Unknown ids are ignored, so a new build of a filter gets a new id (`rnnoise-v2`) and older clients keep loading theirs.

```json
{ "filters": [{ "id": "rnnoise-v1", "wasm": "https://example.org/voice-filters/rnnoise-v1/rnnoise.wasm", "wasm_simd": "https://example.org/voice-filters/rnnoise-v1/rnnoise_simd.wasm" }] }
```

`rnnoise-v1` pairs with the files of [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1. An empty list or an error leaves the browser's own noise suppression.

### `calls`

Needs a token and the features `voice` and `friends`. Voice calls between two friends from the DM window. Ringing runs over IRC (see [IRCv3 support](ircv3.md#client-tags)), the API only hands out the room and rings app builds.

| Request | Answer |
|---------|--------|
| `POST chat/voice/call-token` | Body `{ "peer": "bob", "nick": "alice" }` (`peer`: account of the other side). Same answer as `chat/voice/token`. Both sides have to get the same room, for example `dm:` plus both account names sorted. `403` with `reason: "not_friends"` for anyone who is no friend. |
| `POST chat/voice/call-ring` | Body `{ "peer": "bob", "call_id": "…", "nick": "alice", "action": "invite" \| "cancel" }`. Rings the app builds of the other side (for example through FCM) or takes the notification back. Answer `{ "pushed": 1 }`, the number of installs reached; `0` without a push service. |

An app build that receives the ring opens the chat with `openPushTarget('call:id=…&nick=…&account=…&answer=accept|decline')` (`answer` optional, without it the chat rings). In the background a browser or desktop chat shows a system notification and sends `call-incoming` with `{ nick }` to `onHostMessage`, so a desktop shell can flash its window.

### `spotify`

Used by the [desktop app](desktop.md). The network keeps the Spotify link of the account (OAuth with its own Spotify app) and asks Spotify for the user. All requests need the token.

| Request | Answer |
|---------|--------|
| `GET spotify/auth-url` | `{ "url": "https://…" }`, a one-time link the app opens in the browser to link the account. |
| `GET spotify/status` | `{ "connected": true }` |
| `GET spotify/current-track` | `{ "title": "…", "artist": "…" }`, or `null` when nothing plays. |
| `DELETE spotify/disconnect` | `{ "ok": true }` |

### `communities`

Needs a token. Groups of channels the user belongs to. Each one gets an icon in the rail: picking it shows only its channels (the ones not joined yet as joinable) and opens its lobby. Home shows every joined channel, the ones of a community grouped under its name. Creating communities, members and roles are left to the network's website.

```
GET my-communities
```

```json
[
  { "id": 1, "name": "Starfleet", "slug": "starfleet", "lobby_channel": "#bridge", "channels": ["#bridge", "#engineering"] }
]
```

| Field | Type | Meaning |
|-------|------|---------|
| `id` | number or string | |
| `name` | string | Shown in the rail (first letter) and as the group heading. |
| `slug` | string, optional | Letters, digits, `_` and `-`. Fills `{community}` in `links.communityInvite`. |
| `lobby_channel` | string or `null` | Opened first. Must be one of `channels`, otherwise the first channel is used. |
| `channels` | array of strings | In the order the community wants them. Compared in lower case. |

An empty list for users without communities. The client loads it after every registration. While a community is shown, the `events` feature asks for `chat/events?community=<id>` and the server returns only that community's events.

### Other features

The endpoints of the other features are added here when their modules move into StarChat.
