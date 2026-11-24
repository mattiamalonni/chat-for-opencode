# Reference

Commands and settings are generated from `package.json` + `package.nls.json` by `npm run gen:docs`.
Do not edit the generated blocks by hand; change the manifest and regenerate.

## Commands

<!-- BEGIN GENERATED: commands -->

| Command                                                | Default key    | Notes                                                                      |
| ------------------------------------------------------ | -------------- | -------------------------------------------------------------------------- |
| OpenCode: New Session                                  | –              |                                                                            |
| OpenCode: Open Extension Settings                      | –              | toolbar gear icon                                                          |
| OpenCode: Restart Server…                              | –              | toolbar, with confirmation                                                 |
| OpenCode: Compact Conversation                         | –              |                                                                            |
| OpenCode: Search All Session Conversations             | Cmd/Ctrl+Alt+F | searches titles and message bodies across every session                    |
| OpenCode: Stop current response                        | –              | also click the status bar while a turn runs                                |
| OpenCode: Open Chat in Editor                          | –              |                                                                            |
| OpenCode: Account                                      | –              | view saved logins or sign in                                               |
| OpenCode: Show Logs                                    | –              | toolbar overflow menu                                                      |
| OpenCode: Set Server Password…                         | –              | external server only                                                       |
| OpenCode: Stop Server                                  | –              |                                                                            |
| OpenCode: Move Chat View… (left/right side bar, panel) | –              | left/right side bar or panel                                               |
| OpenCode: Install OpenCode…                            | –              | copy the install command, open platform instructions, retry the connection |

<!-- END GENERATED: commands -->

## Settings

<!-- BEGIN GENERATED: settings -->

| Setting                           | Default                                    | Description                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode.executablePath`         | `"opencode"`                               | Path of the `opencode` executable used to start `opencode serve` (one process per workspace folder).                                                                                                                                                                                                                                                                                              |
| `opencode.endpoint`               | `""`                                       | URL of an already running OpenCode server (e.g. `http://127.0.0.1:4096`). When set, no process is started; use **OpenCode: Set Server Password…** to store its password in the OS keychain.                                                                                                                                                                                                       |
| `opencode.autoContext`            | `true`                                     | Show the active file and selection as context chips. Selections are attached automatically; add the active file to a message with one click.                                                                                                                                                                                                                                                      |
| `opencode.dropzone`               | `true`                                     | Enable drag & drop of files into the chat to attach them to the message. Enabled by default; disable it if drag & drop interferes with VS Code (which normally opens dropped files in an editor unless Shift is held).                                                                                                                                                                            |
| `opencode.startupTimeout`         | `30000`                                    | Milliseconds to wait for `opencode serve` to become healthy.                                                                                                                                                                                                                                                                                                                                      |
| `opencode.autoRestart`            | `true`                                     | Restart the managed server automatically if it exits unexpectedly (max 5 times in 2 minutes).                                                                                                                                                                                                                                                                                                     |
| `opencode.sessionPermissions`     | ask before edits, shell and external files | Permission rules (`action`, `resource`, `effect`) added to new sessions. By default the extension asks before edits, shell commands and access outside the workspace; set `[]` to restore OpenCode's permissive defaults. See https://opencode.ai/docs/permissions/.                                                                                                                              |
| `opencode.autoApprovePermissions` | `false`                                    | Automatically approve every permission request (edits, shell commands, access outside the workspace) without showing the approval panel above the composer. Requests are granted once, so saved rules are untouched. Off by default: enable it only if you trust the agent with unattended changes.                                                                                               |
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
the model picker and `Cmd/Ctrl+N` starts a new session when the chat has focus. In the session list,
`↑`/`↓` walk the filtered sessions, `Enter` selects one and returns focus to the composer
(`Esc`/`Cmd/Ctrl+L` closes it). Selecting a model also returns focus to the composer.
`Enter` in the composer sends or queues while the agent runs, `Ctrl/Cmd+Enter` interrupts and sends
now, and `Shift+Enter` adds a new line.
