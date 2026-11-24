# Server list

The login dialog offers a list of IRC networks. The public list is [`servers/servers.json`](../servers/servers.json), checked against [`servers/servers.schema.json`](../servers/servers.schema.json).

With `serverList: 'default'` the client loads it from GitHub and caches it for 24 hours, falling back to the copy in the package. A merged network shows up everywhere within a day, without a release. A URL loads your own list in the same format, `false` offers only the primary server.

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
            "irc": { "host": "irc.example.org", "port": 6697, "tls": true },
            "discovery": false
        }
    ]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Lower case letters, digits and `-`. Never change it. |
| `name` | yes | Up to 60 characters. |
| `domain` | yes | Where the [discovery file](discovery.md) is looked up. |
| `languages` | yes | For example `["en"]`. |
| `description` | no | Per language, up to 200 characters. |
| `websocket` | one of both | `wss://` address, needed for the web build. |
| `irc` | one of both | TCP `host`, `port` and `tls`, used by the apps. |
| `discovery` | yes | `true` if the network serves a [discovery file](discovery.md), `false` if not. The client only looks for the file when it is not `false`. A URL on `domain` or a subdomain if the file is not at the default place. |

## Adding a network

Open a pull request against `servers/servers.json`. Networks with a discovery file come first, then all entries are sorted by name. Check it first:

```
npm install
npm run validate:servers
```

What the server needs for the web build is in [Hosting](hosting.md#what-your-network-needs). If it checks origins, add `https://getstarchat.net` for the demo.
