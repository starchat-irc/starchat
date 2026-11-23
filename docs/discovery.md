# Discovery file

A network tells StarChat its WebSocket address and extra services with a JSON file on its own domain:

```
https://<domain>/.well-known/starchat.json
```

`<domain>` is the `domain` from the [server list](servers.md) or what the user typed. Every field except `schemaVersion` is optional. Example: [`discovery.example.json`](discovery.example.json), schema: [`discovery.schema.json`](discovery.schema.json).

## Rules

- The file is fetched over `https` without cookies. Serve it with `Access-Control-Allow-Origin: *`.
- Redirects and a `discovery` URL in the server list must stay on the domain or its subdomains. Otherwise a list entry could hand out a foreign API and collect logins.
- Addresses inside the file may be on any domain, but must be `https` or `wss`. Others are dropped.
- Unknown fields and values are ignored, so newer files work with older clients.

## Fields

| Field | Meaning |
|-------|---------|
| `schemaVersion` | `1`. Required. |
| `name` | Name of the network, max. 60 characters. |
| `websocketUrl` | `wss://` address of IRC over WebSocket. |
| `apiBaseUrl` | Base URL of the API. Needed for `features`. |
| `auth` | Login methods, see below. |
| `features` | Services of the API, see below. |
| `branding.logo` | Logo URL. |
| `branding.themeCss` | Stylesheet with the network's theme variables. |
| `links` | Pages of the network's website, see below. |

## Links

| Field | Meaning |
|-------|---------|
| `links.register` | Creating an account. |
| `links.channelInvite` | Invite page of a channel, with `{channel}` for the name without `#`, for example `https://example.org/join/{channel}`. |
| `links.reportPolicy` | Rules for reports. |
| `links.communityInvite` | Invite page of a community, with `{community}` for its `slug`. |

## Login methods (`auth`)

| Value | Meaning |
|-------|---------|
| `sasl-plain` | Account and password over SASL `PLAIN`. |
| `bearer` | Name and password go to the API, the token it returns logs in on IRC with SASL `IRCV3BEARER`. |
| `api-login` | Name and password go to the API for a token and to IRC with SASL `PLAIN`. For IRC servers without token login, for example with Anope. |
| `guest` | Connecting without an account. |

Without `auth` the client assumes `sasl-plain` and `guest`. With both `bearer` and `api-login`, `bearer` wins.

## Features

What each feature shows the user is in [Features](features.md). Endpoints are in the [API reference](openapi.yaml).

| Value | Endpoints | Token |
|-------|-----------|-------|
| `profiles` | [`chat/profiles/{account}`, `chat/profile`, …](openapi.yaml#profiles) | yes |
| `friends` | [`friends`, …](openapi.yaml#friends) | yes |
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

"Optional" means the token is sent when there is one.

## API

Paths are relative to `apiBaseUrl`. The client sends `Accept: application/json` and no cookies, so the API must allow cross-origin requests (`Access-Control-Allow-Origin` and `Authorization` as allowed header).

The API accepts the token as `Authorization: Bearer <token>`. With `bearer` the IRC server accepts it too, with SASL `IRCV3BEARER`. The client gets it from the page that embeds the chat ([Embedding with login](embedding.md)) or, with `bearer` or `api-login` in `auth`, from [`POST login`](openapi.yaml#login). A token only goes to the network it belongs to. Without a token, features that need one stay hidden. Answer `401` for a missing or expired token.

How to set it up with Ergo: [One login for IRC and the API](features.md#one-login-for-irc-and-the-api).
