# Features

StarChat works on every IRC network with WebSocket. Some functions need more from the network: an IRCv3 capability of the IRC server, or a service the network offers through its [discovery file](discovery.md) and API. This page lists what the user gets in each case and what the network has to provide.

## On every network

These work without a discovery file, as long as the IRC server offers the capability where one is named. See [IRCv3 support](ircv3.md) for the full list.

- Channels, direct messages, nick list, topics and modes, channel list (`LIST`) with search
- Login with account and password (SASL `PLAIN`) or as a guest
- History when opening a channel and scrolling up (`chathistory`)
- Reactions, replies and typing indicators (`message-tags`)
- Deleting own messages (`draft/message-redaction`), multiline messages (`draft/multiline`)
- Read position shared by all sessions of an account (`draft/read-marker`)
- Avatars and status set by other clients (`draft/metadata-3` or `draft/metadata-2`)
- Browser push notifications for logged-in accounts (`draft/webpush`, needs the [`pushWorker`](options.md#push-notifications) option)
- Highlight words, ignore list, quit message, nick colors, autojoin, drafts, message search, [commands and shortcuts](commands.md)
- Light and dark theme, English and German

## With a discovery file

A network that serves `/.well-known/starchat.json` can set its name, WebSocket address, logo and theme, and link pages of its website:

| Discovery entry | What the user gets |
|-----------------|--------------------|
| `links.register` | "Create account" link in the login dialog. |
| `links.channelInvite` | "Copy invite link" in the channel menu. |
| `links.reportPolicy` | Link to the rules in the report dialog. |
| `links.communityInvite` | "Copy invite link" for a community (feature `communities`). |
| `auth: ["bearer"]` | One login for IRC and the API: the client gets a token from the API and logs in with SASL `IRCV3BEARER`. |

## With an API

Features below need `apiBaseUrl` and the feature name in `features`. Most also need a token, so guests do not see them. The endpoints of each feature are described under [API](discovery.md#api).

| Feature | What the user gets | Token |
|---------|--------------------|-------|
| `profiles` | Profile cards with avatar, status and member date. Own avatar and status can be changed in the settings. | yes |
| `friends` | Friend list and requests, a friends section in the sidebar with online state, requests from the profile card. | yes |
| `uploads` | Images and files in messages: paste, drop or pick, with progress. | yes |
| `gifs` | GIF search in the message input. | no |
| `reports` | Reporting users and messages to the network's moderators. Guests may report. | no |
| `explore` | A directory tab in the channel list: groups of channels the network lists, joined together. | no |
| `chatState` | Open conversations and settings synced across devices. | yes |
| `alwaysOn` | Staying in channels while no client is connected. The client asks once after the first login. | yes |
| `events` | A calendar button in the sidebar with upcoming events, linked to their channels. | yes |
| `communities` | An icon per community in the rail. Picking one shows its channels and opens its lobby, Home groups the joined channels by community. With `links.communityInvite` a "Copy invite link" button. | yes |
| `push` | Push notifications in app builds, relayed by the network to Firebase Cloud Messaging. Browsers do not need it. | yes |
| `voice` | Voice chat per channel (experimental, switched on in the settings). Push to talk or voice activation, mic test, volume per participant, optional noise filter. Needs a [LiveKit](https://livekit.io) server. | yes |
| `calls` | Voice calls between friends from the direct message window (experimental). Needs `voice` and `friends`. | yes |

## Client only

| Module | What it does |
|--------|--------------|
| `share` | Receives text, links and files shared to an app build and offers to send them. |

A page can leave out modules it does not want with the `modules` option of [`mountChat()`](options.md). A feature is only active when its module is loaded and the network offers it.
