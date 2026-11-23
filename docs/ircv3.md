# IRCv3 support

StarChat requests these capabilities when the server offers them and falls back to plain IRC otherwise. It is developed against [Ergo](https://ergo.chat), which supports all of them.

## Capabilities

| Capability | Used for |
|------------|----------|
| `sasl` | Login with `PLAIN` or `IRCV3BEARER` ([token](embedding.md)). |
| `message-tags` | Reactions, replies, typing indicators. |
| `server-time` | Correct times in history. |
| `echo-message` | Message IDs of own messages, to react, reply or delete. |
| `account-tag` | The sender's account, so a nick alone is never trusted. |
| `batch` | History and multiline messages. |
| `away-notify` | Away state in the nick list. |
| `chathistory`, `draft/chathistory` | Earlier messages. |
| `draft/event-playback` | Joins, parts and quits in the history. |
| `draft/message-redaction` | Deleting messages. |
| `draft/multiline` | Messages with several lines. |
| `draft/read-marker` | Read position shared across sessions. |
| `draft/metadata-3`, `draft/metadata-2` | Avatars, status and the voice chat a user is in (key `voice`). |
| `draft/webpush`, `soju.im/webpush` | Push while no client is connected. Browsers need [`pushWorker`](options.md#push-notifications), apps the network feature `push`. |

## Client tags

| Tag | Used for |
|-----|----------|
| `+draft/react`, `+draft/unreact` | Reactions. |
| `+draft/reply` | Replies. |
| `+typing` | Typing indicators. |
| `+getstarchat.net/call`, `+getstarchat.net/call-id` | Ringing for calls between friends, as `TAGMSG` to the nick. |

Reactions and replies are hidden when the server denies the tags with `CLIENTTAGDENY`.

### Calls

`+getstarchat.net/call-id` is a random id of up to 32 letters and digits. `+getstarchat.net/call` is one of:

| Value | Sent by | Meaning |
|-------|---------|---------|
| `invite` | caller | Ring. The caller is already in the voice room. |
| `ringing` | callee | It rings. Without it within 6 seconds the caller gives up. |
| `unavailable` | callee | This client takes no calls. |
| `busy` | callee | Already in a call. |
| `accept`, `decline` | callee | The answer. Other sessions of the account stop ringing. |
| `cancel` | caller | Gave up before an answer. |
| `end` | either | Hung up. |

Only invites from friends ring.
