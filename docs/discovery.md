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

Without `auth` the client assumes `sasl-plain` and `guest`, like any IRC server. The API endpoints for `bearer` are described together with the features.

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

The API endpoints of each feature are not fixed yet. They follow when the features move into StarChat.
