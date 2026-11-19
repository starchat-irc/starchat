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
| `bearer` | | Function that returns a login token, see [Embedding with login](embedding.md). |
| `locale` | browser languages | Language code or list of codes, for example `'de-DE'`. The first one with bundled texts wins, English otherwise. |
| `theme` | `'auto'` | `'auto'` follows the system setting, `'dark'` or `'light'` fix it. Users can change it in the settings, their choice is kept in the browser. |
| `overrides` | `{}` | Texts that replace bundled ones, by key (see `src/i18n/en.json`). |
| `appName` | `'StarChat'` | Name shown in texts that mention the app. |
| `ctcpVersion` | `'StarChat'` | Answer to CTCP VERSION. |
| `defaultQuitMessage` | | Quit message until the user sets one. |
| `Alpine` | bundled | An Alpine.js instance your page already runs, for example from Livewire. Without it StarChat starts its own. Never run two. |
| `onHostMessage` | | `(type, data) => {}`. Messages from the chat for the page around it, for example unread counts. |

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

## Own commands

Slash commands are a plain object keyed by name. Add your own before mounting:

```js
import { registerCommand } from 'starchat';

registerCommand('shrug', (args, ctx) => {
    ctx.sendOwnMessage(ctx.currentChannel, `${args.join(' ')} ¯\\_(ツ)_/¯`.trim());
});
```

An existing name is replaced. The built-in commands are listed in [Commands and shortcuts](commands.md).
