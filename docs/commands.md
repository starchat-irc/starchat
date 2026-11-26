# Commands and shortcuts

## Slash commands

Commands start with `/` in the input field. Anything not listed here can be sent to the server with `/quote`.

| Command | Meaning |
|---------|---------|
| `/join #channel[,#other]` | Join one or more channels. The `#` can be left out. |
| `/part [#channel[,#other]]` | Leave the current channel, or the given ones. |
| `/msg <nick> <text>` | Send a direct message and open the conversation. Messages to services (NickServ, ChanServ, ...) go to the server window. |
| `/me <text>` | Action message. |
| `/nick <newnick>` | Change your nick. |
| `/displayname [name]` | Set your display name. Without a name it is removed. Needs `draft/metadata-3` on the server. |
| `/away [message]` | Mark yourself as away. |
| `/back` | Remove the away mark. |
| `/whois <nick>` | Show information about a user. |
| `/list` | List the channels of the network. |
| `/ignore [nick]` | Ignore a user. Without a nick, show the ignore list. |
| `/unignore <nick>` | Stop ignoring a user. |
| `/highlight` | Show your highlight words. |
| `/highlight add <word>[, ...]` | Add highlight words, comma separated. |
| `/highlight del <word>` | Remove a highlight word. |
| `/highlight clear` | Remove all highlight words. |
| `/ns`, `/cs`, `/hs`, `/ms`, `/os <command>` | Send a command to NickServ, ChanServ, HostServ, MemoServ or OperServ. |
| `/ctcp <nick> <command> [text]` | Send a CTCP request, for example `/ctcp alice PING`. |
| `/version [nick]` | Version of the server, or of a user's client. |
| `/server` | Open the server window. |
| `/quote <line>`, `/raw <line>` | Send a raw IRC line. |
| `/roll` | Roll a d20 in the current channel. |
| `/flip` | Flip a coin in the current channel. |
| `/scene [#channel] <text>` | Narration line (Ergo roleplay, `SCENE`). |
| `/npc [#channel] <name> <text>` | Line of a non-player character (Ergo roleplay, `NPC`). |
| `/npca [#channel] <name> <text>` | Action of a non-player character (Ergo roleplay, `NPCA`). |

Sites can add their own commands, see [Own commands](options.md#own-commands).

## Keyboard shortcuts

| Keys | Meaning |
|------|---------|
| `Ctrl+P` | Quick switcher: jump to a channel or conversation. |
| `Ctrl+F` | Search in the current channel or conversation. |
| `Alt+Up`, `Alt+Down` | Previous or next entry in the sidebar. |
| `Ctrl+K` | Insert a mIRC color. |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+U` | Bold, italic, underline. |
| `Tab` | Complete nicks, channels and commands. |
| `Shift+Enter` | New line in the message. |
| `Up`, `Down` | Earlier messages you sent (input history). |
| `Esc` | Cancel a reply or close the open window. |
| `?` or `Ctrl+/` | Show all shortcuts. |
