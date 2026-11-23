# mountChat() options

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

The first argument is a selector or an element. The chat fills it, so give it a height. The promise resolves with the connection of the primary server and the server list, and rejects when the element is missing or no server could be resolved.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `primaryServer` | | Domain or a [server list](servers.md) entry, preselected in the login dialog. |
| `serverList` | `'default'` | `'default'` (the public list), a URL of your own list, or `false`. |
| `defaultChannel` | | Channel joined after login on the primary server. |
| `nickname` | | Connect right away with this nick, without the login dialog. |
| `password` | | SASL password for `nickname`. |
| `saslAccount` | the nick | Account name, if it differs from the nick. |
| `bearer` | | Function that returns a token, see [Embedding with login](embedding.md). |
| `modules` | all | Feature modules, for example `[profilesModule]`. A module runs only where the network lists its [feature](discovery.md#features). `[]` gives a plain IRC client. |
| `locale` | browser | Language code or list. English if none matches. |
| `theme` | `'auto'` | `'auto'`, `'dark'` or `'light'`. Users can change it. |
| `overrides` | `{}` | Replaced texts by key (see `src/i18n/en.json`). |
| `layout` | `'full'` | `'headless'` or an object, see [below](#chat-box-without-frame). |
| `appName` | `'StarChat'` | Name in texts. |
| `ctcpVersion` | `'StarChat'` | Answer to CTCP VERSION. |
| `defaultQuitMessage` | | Quit message until the user sets one. |
| `Alpine` | bundled | Your page's Alpine.js instance, for example from Livewire. Never run two. |
| `onHostMessage` | | `(type, data) => {}`, messages from the chat to the page, for example unread counts. |
| `pushWorker` | | URL of the push service worker, see [below](#push-notifications). |

Options for app shells (`shell`, `shellMessages`, `nativeSocket`, `storageScope`, `allowInsecureWebsocket`) are used by the desktop and mobile apps, see `src/ui/mount.js`.

## Chat box without frame

`layout: 'headless'` shows only the messages and the input line, for a game or an app that wants a chat box. The chat then leaves the page's keys alone.

```js
await mountChat('#chatbox', {
    primaryServer: 'irc.example.org',
    defaultChannel: '#village',
    layout: 'headless',
    bearer: async () => ({ token: await fetchChatToken() }),
});
```

An object switches single parts off: `header`, `channelList`, `userList`, `joinPart`, `logout`, `shortcuts`.

```js
layout: { userList: false, joinPart: false }
```

Without the channel list there is no way back from `/join` or `/query` other than another command, so set a `defaultChannel`.

## Theme

`starchat/theme.css` needs Bootstrap 5 and Bootstrap Icons loaded before it. Colors are custom properties on the chat element (see `src/ui/theme.css`):

```css
#chat {
    --chat-accent: #2e7d32;
    --chat-accent-hover: #256628;
}
```

## Notification sound

```js
import { registerNotificationSound } from 'starchat';

registerNotificationSound('/sounds/ping.ogg');
```

The sound becomes the default. Pass `{ makeDefault: false }` to only offer it.

## Push notifications

On networks with `draft/webpush` logged-in users get messages while the chat is closed. Copy `starchat/push-sw.js` to your public folder and pass its URL:

```js
await mountChat('#chat', {
    primaryServer: 'irc.example.org',
    pushWorker: '/push-sw.js?name=MyNet&chat=/chat&icon=/icon.png',
});
```

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `name` | `StarChat` | Title of notifications without a sender. |
| `chat` | `/` | Path of the chat page, opened with `?open=<target>` on tap. |
| `icon` | `/favicon.ico` | Notification icon. |

Users turn it on under Settings, Notifications. No network API is needed, only apps need the feature [`push`](features.md#push).

## Own commands

```js
import { registerCommand } from 'starchat';

registerCommand('shrug', (args, ctx) => {
    ctx.sendOwnMessage(ctx.currentChannel, `${args.join(' ')} ¯\\_(ツ)_/¯`.trim());
});
```

An existing name is replaced. Built-in commands: [Commands and shortcuts](commands.md).
