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
| `draft/metadata-3` or `draft/metadata-2` | Avatars and status of users, the voice chat a user is in (key `voice`). |
| `draft/webpush` or `soju.im/webpush` | Push notifications for logged-in accounts while no client is connected. In the browser it needs the `pushWorker` option ([Push notifications](options.md#push-notifications)), apps need the `push` feature of the network. |

## Client tags

| Tag | Used for |
|-----|----------|
| `+draft/react`, `+draft/unreact` | Emoji reactions to a message. |
| `+draft/reply` | Answers to a specific message. |
| `+typing` | Shown when other users type. |
| `+getstarchat.net/call`, `+getstarchat.net/call-id` | Ringing for voice calls between friends (feature `calls`), sent as `TAGMSG` to the nick. |

Reactions and replies are offered only when the server does not deny the tags with `CLIENTTAGDENY` in `ISUPPORT`.

### Calls

`+getstarchat.net/call` carries the step of the call, `+getstarchat.net/call-id` a random id of up to 32 letters and digits that keeps two calls apart.

| Value | Sent by | Meaning |
|-------|---------|---------|
| `invite` | caller | It should ring. The caller is already waiting in the voice room. |
| `ringing` | callee | It rings here. Without it within 6 seconds the caller assumes a client without calls and gives up. |
| `unavailable` | callee | Voice is switched off here. |
| `busy` | callee | Already in a call or another one rings. |
| `accept`, `decline` | callee | The answer. Other sessions of the same account see it as echo and stop ringing. |
| `cancel` | caller | Gave up before an answer. |
| `end` | either | Hung up. |

Only invites from friends ring (by `account` tag, otherwise by nick). Calls publish no metadata.

## Tested servers

StarChat is developed against [Ergo](https://ergo.chat), which supports all of the above. Other servers work with the subset they offer.
