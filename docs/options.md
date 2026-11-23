# mountChat() options

`mountChat()` renders the chat into an element of your page and connects to the first server.

```js
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import 'starchat/theme.css';
import { mountChat } from 'starchat';

const { connection, servers } = await mountChat('#chat', {
    primaryServer: 'irc.example.org',
    defaultChannel: '#lobby',
});
```

The first argument is a CSS selector or an element. Its content is replaced. The chat takes all the space the element gives it, so give the element a height or let it fill a flex container.

The returned promise resolves with the connection of the primary server and the list of servers offered in the login dialog. It rejects when the element is missing or no server could be resolved.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `primaryServer` | | Domain (`'irc.example.org'`) or a full [server list](servers.md) entry. Preselected in the login dialog. A domain that is not in the list becomes an entry of its own, its WebSocket address then comes from the [discovery file](discovery.md). |
| `serverList` | `'default'` | `'default'` loads the public list, a URL loads your own list in the same format, `false` offers only the primary server. |
| `defaultChannel` | | Channel joined and shown after login. Only used on the primary server. |
| `nickname` | | Connect right away with this nick instead of showing the login dialog. |
| `password` | | SASL PLAIN password used with `nickname`. |
| `saslAccount` | the nick | Account name for SASL PLAIN when it differs from the nick. |
| `bearer` | | Function that returns a login token, see [Embedding with login](embedding.md). |
| `modules` | all bundled | Feature modules, for example `[profilesModule]` (exported by the package). A module only runs on servers that list its feature in the [discovery file](discovery.md#features). Pass `[]` for a plain IRC client. |
| `locale` | browser languages | Language code or list of codes, for example `'de-DE'`. The first one with bundled texts wins, English otherwise. |
| `theme` | `'auto'` | `'auto'` follows the system setting, `'dark'` or `'light'` fix it. Users can change it in the settings, their choice is kept in the browser. |
| `overrides` | `{}` | Texts that replace bundled ones, by key (see `src/i18n/en.json`). |
| `layout` | `'full'` | Parts of the chat that are shown. `'headless'` leaves only the messages and the input line, see [Chat box without frame](#chat-box-without-frame). |
| `appName` | `'StarChat'` | Name shown in texts that mention the app. |
| `ctcpVersion` | `'StarChat'` | Answer to CTCP VERSION. |
| `defaultQuitMessage` | | Quit message until the user sets one. |
| `Alpine` | bundled | An Alpine.js instance your page already runs, for example from Livewire. Without it StarChat starts its own. Never run two. |
| `onHostMessage` | | `(type, data) => {}`. Messages from the chat for the page around it, for example unread counts. |
| `shellMessages` | | `(listener) => {}`. Called once with a `listener(type, data)` for messages from the app around the chat: `settings-state`, `set-theme`, `open-settings`, `tab-activated`, `set-playing`, `app-resumed`. Other types go to the modules (hook `shellMessage`). Used by the [desktop app](desktop.md). |
| `shell` | | `'desktop'` or `'mobile'` when the chat runs inside an app that keeps some settings itself. |
| `allowInsecureWebsocket` | `false` | Only inside a `primaryServer` entry: accept a `ws://` address (no TLS) for this server. Server lists cannot switch it on. The desktop app sets it for servers the user set up with `ws://`. |
| `storageScope` | server id | Suffix of the keys under which settings and drafts of this connection are stored in the browser. The desktop app passes the id of the connection profile, so two connections to one server keep their own settings. |
| `nativeSocket` | | IRC over TCP for apps that can open sockets: `nativeSocketConnector({ send, listen })`, see `src/core/native-socket.js`. Used for servers that have `irc` but no `websocket` in their entry. |
| `pushWorker` | | URL of the push service worker on your origin, see [Push notifications](#push-notifications). Without it there is no push in the browser. |

## Chat box without frame

A game or app that only wants a chat box passes `layout: 'headless'`. Then only the messages of the current channel and the input line are shown: no header, no channel list, no user list, no join and part lines, no logout button. The chat also leaves the keys of the page alone (Ctrl+P, Ctrl+F, Alt+Up/Down and `?` are not taken).

```js
await mountChat('#chatbox', {
    primaryServer: 'irc.example.org',
    defaultChannel: '#village',
    layout: 'headless',
    bearer: async () => ({ token: await fetchChatToken() }),
});
```

An object switches single parts off, everything not named stays:

```js
layout: { userList: false, joinPart: false }
```

| Part | Meaning |
|------|---------|
| `header` | Channel name, topic, buttons and the message search. The reconnect notice stays. |
| `channelList` | Icon rail and channel list, with them the friends and upload views. |
| `userList` | Nick list of the channel. |
| `joinPart` | Join and part lines. Kicks, nick changes and topics stay. |
| `logout` | Logout button of the input line. |
| `shortcuts` | Keyboard shortcuts on the whole page. |

Without the channel list the user stays in the channel they see. `/join` and `/query` still switch to the new window, but there is no way back other than another command. Direct messages from others arrive without being shown, so a chat box should set a `defaultChannel`. Settings for hidden parts are not offered.

## Theme

`starchat/theme.css` contains the default theme for dark and light mode. It is built on Bootstrap 5 and Bootstrap Icons, both have to be loaded before it.

The colors are CSS custom properties on the chat element (`--chat-bg`, `--chat-text`, `--chat-accent` and so on, see `src/ui/theme.css`). Override them in your own stylesheet to change the look without touching the layout:

```css
#chat {
    --chat-accent: #2e7d32;
    --chat-accent-hover: #256628;
}
```

The theme is set on the chat element only, so your page keeps its own color scheme.

## Notification sound

The chat brings a few synthesized sounds. A site can add its own sound file, which is then offered first and used by default:

```js
import { registerNotificationSound } from 'starchat';

registerNotificationSound('/sounds/ping.ogg');
```

Pass `{ makeDefault: false }` to only add it to the list.

## Push notifications

On networks with `draft/webpush` (Ergo, soju) logged-in users can get direct messages and mentions while the chat is closed. The browser needs a service worker on the origin of your page. Copy `node_modules/starchat/src/push-sw.js` (package path `starchat/push-sw.js`) to your public folder and pass its URL:

```js
await mountChat('#chat', {
    primaryServer: 'irc.example.org',
    pushWorker: '/push-sw.js?name=MyNet&chat=/chat&icon=/icon.png',
});
```

The query string configures the worker:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `name` | `StarChat` | Title of notifications without a sender. |
| `chat` | `/` | Path of the chat page. A tapped notification focuses a window under this path or opens it with `?open=<target>`. Can be given more than once, the first is opened. |
| `icon` | `/favicon.ico` | Notification icon, a path on your origin. |

The user turns push on under Settings → Notifications, which also asks for the browser permission. Muted channels and ignored users stay silent, the chat sends that list to the worker. Logging out unregisters the device.

No network API is needed for this. Only app builds (FCM) need the network's relay, the feature [`push`](features.md#push).

## Own commands

Slash commands are a plain object keyed by name. Add your own before mounting:

```js
import { registerCommand } from 'starchat';

registerCommand('shrug', (args, ctx) => {
    ctx.sendOwnMessage(ctx.currentChannel, `${args.join(' ')} ¯\\_(ツ)_/¯`.trim());
});
```

An existing name is replaced. The built-in commands are listed in [Commands and shortcuts](commands.md).
