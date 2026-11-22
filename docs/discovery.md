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

All paths are relative to `apiBaseUrl`. The endpoints, fields and answers of every feature are in the [API reference](openapi.yaml) (OpenAPI 3.1). The client sends `Accept: application/json` and no cookies, so the API has to answer cross-origin requests (`Access-Control-Allow-Origin: *` or the calling origin, `Authorization` as allowed header).

### Token

The token is a string the IRC server accepts with SASL `IRCV3BEARER` and the API accepts as `Authorization: Bearer <token>`. With [Ergo](https://ergo.chat) this is a JWT signed with a key from `accounts.jwt-auth`, the account name in `sub`. See [Features](features.md#one-login-for-irc-and-the-api) for an example.

A client gets a token in one of two ways:

- From the page that embeds the chat (`mountChat({ bearer })`, see [Embedding with login](embedding.md)).
- With `bearer` in `auth`, from the login form: [`POST login`](openapi.yaml#login) with name and password.

The client then logs in on IRC with `IRCV3BEARER` instead of `PLAIN`. Without `bearer` in `auth` a password goes to the IRC server with SASL `PLAIN` and the client has no token, so features that need one stay hidden. Guests have no token either. An API request with a missing or expired token is answered with `401`.

### Endpoints per feature

| Feature | Endpoints | Token |
|---------|-----------|-------|
| `profiles` | [`chat/profiles/{account}`, `chat/profile`, `chat/profile/status`, `chat/profile/avatar`](openapi.yaml#profiles) | yes |
| `friends` | [`friends`, `friends/request`, `friends/{id}/…`](openapi.yaml#friends) | yes |
| `uploads` | [`chat/media-upload`](openapi.yaml#uploads) | yes |
| `gifs` | [`gifs/search`](openapi.yaml#gifs) | optional |
| `reports` | [`chat/reports`](openapi.yaml#reports) | optional |
| `explore` | [`explore`](openapi.yaml#explore) | optional |
| `chatState` | [`chat-state`](openapi.yaml#chatstate) | yes |
| `alwaysOn` | [`chat/always-on`](openapi.yaml#alwayson) | yes |
| `events` | [`chat/events`](openapi.yaml#events) | yes |
| `communities` | [`my-communities`](openapi.yaml#communities) | yes |
| `push` | [`chat/push-devices`](openapi.yaml#push) | yes |
| `voice` | [`chat/voice/token`, `chat/voice/filters`](openapi.yaml#voice) | yes |
| `calls` | [`chat/voice/call-token`, `chat/voice/call-ring`](openapi.yaml#calls) | yes |
| `spotify` | [`spotify/…`](openapi.yaml#spotify) | yes |

"Optional" means the token is sent if there is one, so guests can use the feature unless the network answers them with `401`. How a network can offer each feature, for example with Ergo or LiveKit, is described in [Features](features.md#setting-up-the-features).
