# Discovery file

A network can tell StarChat its WebSocket address and the extra services it offers with a small JSON file on its own domain, at this address:

```
https://<domain>/.well-known/starchat.json
```

`<domain>` is the `domain` of the network in [`servers/servers.json`](../servers/servers.json), or the domain a user typed in. Networks without this file work as plain IRC servers. The file is optional, and so is every field except `schemaVersion`.

Example: [`discovery.example.json`](discovery.example.json). Schema: [`discovery.schema.json`](discovery.schema.json).

## Where the file is looked up

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

Endpoints may be on other domains than the network itself, for example an API on a separate host. They must use `https` or `wss`. Plain `http` and `ws` are dropped.

Unknown fields and unknown values in `auth` and `features` are ignored, so a file written for a newer client still works with an older one. New fields and values are added to this document first.

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
| `push` | Push notifications. Only works in builds with their own app ID. |
| `voice` | Voice channels. |
| `calls` | Voice calls between friends. |
| `reports` | Reporting users and messages. |
| `explore` | Directory of channels and communities. |
| `chatState` | Open conversations and read markers synced across devices. |
| `alwaysOn` | Staying connected while the client is closed (bouncer). |
| `events` | Community events in the chat. |
| `gifs` | GIF search in the message input. |

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

### Other features

The endpoints of the other features are added here when their modules move into StarChat.
