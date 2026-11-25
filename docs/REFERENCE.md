# Reference

Commands and settings are generated from `package.json` + `package.nls.json` by `npm run gen:docs`.
Do not edit the generated blocks by hand; change the manifest and regenerate.

## Commands

<!-- BEGIN GENERATED: commands -->

| Command                                                | Default key    | Notes                                                                        |
| ------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------- |
| OpenCode: New Session                                  | –              |                                                                              |
| OpenCode: Open Extension Settings                      | –              | toolbar gear icon                                                            |
| OpenCode: Restart Server…                              | –              | toolbar, with confirmation                                                   |
| OpenCode: Compact Conversation                         | –              |                                                                              |
| OpenCode: Search All Session Conversations             | Cmd/Ctrl+Alt+F | searches titles and message bodies across every session                      |
| OpenCode: Stop current response                        | –              | also click the status bar while a turn runs                                  |
| OpenCode: Open Chat in Editor                          | –              |                                                                              |
| OpenCode: Account                                      | –              | view saved logins or sign in                                                 |
| OpenCode: Connect Provider…                            | –              |                                                                              |
| OpenCode: Show Logs                                    | –              | toolbar overflow menu                                                        |
| OpenCode: Set Server Password…                         | –              | external server only                                                         |
| OpenCode: Stop Server                                  | –              |                                                                              |
| OpenCode: Move Chat View… (left/right side bar, panel) | –              | left/right side bar or panel                                                 |
| OpenCode: Check setup…                                 | –              | show the bundled-SDK setup help, open settings or logs, retry the connection |

<!-- END GENERATED: commands -->

## Settings

<!-- BEGIN GENERATED: settings -->

| Setting                           | Default                                    | Description                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode.endpoint`               | `""`                                       | URL of an OpenCode server you run yourself (e.g. `http://127.0.0.1:4096`). When unset, the bundled SDK hosts OpenCode inside VS Code. Use **OpenCode: Set Server Password…** to store the server password in the OS keychain.                                                                                                                                                                     |
| `opencode.autoContext`            | `true`                                     | Show the active file and selection as context chips. Selections are attached automatically; add the active file to a message with one click.                                                                                                                                                                                                                                                      |
| `opencode.dropzone`               | `true`                                     | Enable drag & drop of files into the chat to attach them to the message. Enabled by default; disable it if drag & drop interferes with VS Code (which normally opens dropped files in an editor unless Shift is held).                                                                                                                                                                            |
| `opencode.sessionPermissions`     | ask before edits, shell and external files | Permission rules (`action`, `resource`, `effect`) added to new sessions. By default the extension asks before edits, shell commands and access outside the workspace; set `[]` to restore OpenCode's permissive defaults. See https://opencode.ai/docs/permissions/.                                                                                                                              |
| `opencode.autoApprovePermissions` | `false`                                    | Default for the Auto-approve toggle in this workspace. Automatically approve every permission request (edits, shell commands, access outside the workspace) without showing the approval panel above the composer. Requests are granted once, so saved rules are untouched. Off by default: enable it only if you trust the agent with unattended changes.                                        |
| `opencode.notifyOnComplete`       | `false`                                    | Show a notification when a turn finishes while the chat is hidden, with an action to open it. Off by default to avoid noise on long sessions.                                                                                                                                                                                                                                                     |
| `opencode.notifyOnFailure`        | `true`                                     | Show a notification when a turn fails while the chat is hidden, with an action to open it.                                                                                                                                                                                                                                                                                                        |
| `opencode.sessionPageSize`        | `10`                                       | Number of sessions shown per page in the session list. Use **Load more sessions** to fetch the next page.                                                                                                                                                                                                                                                                                         |
| `opencode.toolOutputLimit`        | `4000`                                     | Characters of a tool's output shown inline before the **output (n)** affordance. Raise it to review long command output without expanding every card.                                                                                                                                                                                                                                             |
| `opencode.promptLibrary`          | `[]`                                       | Reusable prompts offered by `/` in the chat. Each entry needs a unique `id`, a `title` and the `text` to insert; `description` is optional. The text may contain `$selection`, `$file`, `$diff` and `$problems`, which are replaced with the current editor context when you pick it. Built-in prompts (explain, tests, bugs, optimize, document, review, problems, commit) are always available. |
| `opencode.showUsageInStatusBar`   | `true`                                     | Show a status bar item with the current session's estimated context size and cost. The numbers come from OpenCode and appear after the first reply.                                                                                                                                                                                                                                               |

<!-- END GENERATED: settings -->

## Keys inside the chat

`Cmd/Ctrl+F` searches messages (`F3`/`Shift+F3` for next/previous, `Esc` closes and clears),
`Cmd/Ctrl+R` re-syncs the current session, `Cmd/Ctrl+L` toggles the session list, `Cmd/Ctrl+M` opens
the model picker, `Cmd/Ctrl+G` opens the session timeline and `Cmd/Ctrl+N` starts a new session
when the chat has focus. In the session list,
`↑`/`↓` walk the filtered sessions, `Enter` selects one and returns focus to the composer
(`Esc`/`Cmd/Ctrl+L` closes it). Selecting a model also returns focus to the composer.
`Enter` in the composer sends or queues while the agent runs, `Ctrl/Cmd+Enter` interrupts and sends
now, and `Shift+Enter` adds a new line.

## Slash commands handled in chat

The composer resolves these locally before sending anything to OpenCode and lists them alongside
server commands and skills under `/`:

- `/fork [prompt]` copies the full history into a new sibling session, opens it, then sends the
  optional prompt (with attachments and context) in the new branch.
- `/compact [prompt]` compacts the open session, then sends the optional prompt in the same
  conversation.

Both need an idle session: while a turn runs the command is refused and the text stays in the
composer. They shadow a server command with the same name, so their behaviour is always the one
described here.

## Session timeline

`Cmd/Ctrl+G` while the chat has focus opens a searchable picker of this session's turns, newest
first. `↑`/`↓` walk the list, typing filters prompts, `Enter` jumps to the selected prompt and
highlights it, and `Esc` closes the picker. Focus returns to the composer after a jump.
