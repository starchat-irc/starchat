# IRCv3 support

StarChat requests the capabilities below when the server offers them. Without them it falls back to plain IRC, so every server works, but some functions are only available with the matching capability.

## Capabilities

| Capability | Used for |
|------------|----------|
| `sasl` | Login with `PLAIN` (account and password) or `IRCV3BEARER` (token, see [Embedding with login](embedding.md)). |
| `message-tags` | Reactions, replies and typing indicators. |
| `server-time` | Correct times for history and delayed messages. |
| `echo-message` | Own messages come back with their ID, needed to react to, reply to or delete them. |
| `account-tag` | The account of the sender on every message, so a nick alone is never trusted. |
| `batch` | Grouping of history and multiline messages. |
| `away-notify` | Away state in the nick list without polling. |
| `chathistory` or `draft/chathistory` | Loading earlier messages when opening a channel or scrolling up. |
| `draft/event-playback` | Joins, parts and quits in the history as real events. |
| `draft/message-redaction` | Deleting messages. |
| `draft/multiline` | Messages with several lines. |
| `draft/read-marker` | Read position shared by all sessions of an account. |
| `draft/metadata-3` or `draft/metadata-2` | Avatars and status of users. |
| `draft/webpush` or `soju.im/webpush` | Push notifications while no client is connected. Only in builds with their own app ID. |

## Client tags

| Tag | Used for |
|-----|----------|
| `+draft/react`, `+draft/unreact` | Emoji reactions to a message. |
| `+draft/reply` | Answers to a specific message. |
| `+typing` | Shown when other users type. |

Reactions and replies are offered only when the server does not deny the tags with `CLIENTTAGDENY` in `ISUPPORT`.

## Tested servers

StarChat is developed against [Ergo](https://ergo.chat), which supports all of the above. Other servers work with the subset they offer.
