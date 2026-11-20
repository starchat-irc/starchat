# Server list

StarChat offers a list of IRC networks in the login dialog. The public list is [`servers/servers.json`](../servers/servers.json) in this repository, checked against [`servers/servers.schema.json`](../servers/servers.schema.json).

## How the list is loaded

With `serverList: 'default'` the client loads the list from GitHub and keeps it in the browser for 24 hours. When the download fails it uses an older cached copy, and as a last resort the copy shipped with the package. So a new network shows up in every StarChat within a day after its pull request is merged, without a new release.

With `serverList: 'https://example.org/servers.json'` the client loads your own list in the same format. An own list never falls back to the public one.

With `serverList: false` only the primary server is offered.

The [desktop app](desktop.md) works the same way for its directory of networks: the list is bundled at build time, the app loads newer versions itself and keeps them for 24 hours.

## Format

```json
{
    "schemaVersion": 1,
    "servers": [
        {
            "id": "example",
            "name": "Example Network",
            "domain": "example.org",
            "description": { "en": "What your network is about." },
            "languages": ["en"],
            "websocket": "wss://irc.example.org/webirc",
            "irc": { "host": "irc.example.org", "port": 6697, "tls": true }
        }
    ]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable identifier, lower case letters, digits and `-`. Used for saved connections, never change it. |
| `name` | yes | Display name, up to 60 characters. |
| `domain` | yes | Main domain of the network. The [discovery file](discovery.md) is looked up there. |
| `languages` | yes | Language codes of the network, for example `["en"]`. |
| `description` | no | Short description per language code, up to 200 characters each. |
| `websocket` | one of both | IRC over WebSocket (`wss://`). Required for the web build. |
| `irc` | one of both | Plain IRC over TCP with `host`, `port` and `tls`. Only used by the desktop client. |
| `discovery` | no | URL of the discovery file, if it is not at the default location. Must be on `domain` or a subdomain of it. |

## Adding a network to the public list

Open a pull request that adds an entry to `servers/servers.json`. Check it locally first:

```
npm install
npm run validate:servers
```

The same check runs in CI. Networks that only offer TCP are shown in the desktop client only.

## Requirements for the web build

Browsers cannot open TCP connections, so the web build needs IRC over WebSocket. Ergo, UnrealIRCd 6 and InspIRCd (module `m_websocket`) support it. Serve it over TLS, directly or behind a reverse proxy.

Some servers only accept WebSocket connections from listed origins (Ergo: `server.websockets.allowed-origins`). If your network sets such a list, add the origins of the pages your users chat from, for example `https://getstarchat.net`. A server that rejects the origin shows up in the client as a failed connection. After three failed attempts the login dialog explains this instead of retrying forever.
