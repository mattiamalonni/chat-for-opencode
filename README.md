# Chat for OpenCode

[![CI](https://github.com/mattiamalonni/chat-for-opencode/actions/workflows/ci.yml/badge.svg)](https://github.com/mattiamalonni/chat-for-opencode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mattiamalonni/chat-for-opencode)](https://github.com/mattiamalonni/chat-for-opencode/releases/latest)
[![License: MIT](https://img.shields.io/github/license/mattiamalonni/chat-for-opencode)](LICENSE)
[![VS Code 1.130+](https://img.shields.io/badge/VS_Code-1.134%2B-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=mattiamalonni.chat-for-opencode)
[![Last commit](https://img.shields.io/github/last-commit/mattiamalonni/chat-for-opencode)](https://github.com/mattiamalonni/chat-for-opencode/commits/main)
[![Release date](https://img.shields.io/github/release-date/mattiamalonni/chat-for-opencode)](https://github.com/mattiamalonni/chat-for-opencode/releases/latest)
[![OpenCode SDK 2.4.1](https://img.shields.io/badge/OpenCode_SDK-2.4.1-blueviolet)](https://opencode.ai/docs/sdk/)
[![Telemetry: none](https://img.shields.io/badge/telemetry-none-brightgreen)](#privacy--security)
[![TypeScript](https://img.shields.io/github/languages/top/mattiamalonni/chat-for-opencode)](https://www.typescriptlang.org/)

> **Unofficial.** This extension is a vibe-coded community project and is not affiliated with or endorsed by the OpenCode team.

A Copilot-style chat in the VS Code sidebar for [OpenCode](https://opencode.ai), the open-source
coding agent. OpenCode runs **inside the extension** through the bundled `@opencode/sdk` (its HTTP
router executes in memory — no separate process, no port, no CLI to install). The extension never
stores provider API keys itself (the **Connect** panel forwards them once to OpenCode's credential
store) and sends **no telemetry**.

**[Install Chat for OpenCode from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=mattiamalonni.chat-for-opencode)**

## Install

- VS Code **1.134+** (its extension host needs Node 24 for the SDK) and a **trusted workspace** —
  before you trust the folder the extension creates no OpenCode host, reads no saved login and
  ignores workspace-specific settings.
- **No CLI, server or other software to install**: OpenCode 2.4.1 is bundled in the extension.
  Setting `opencode.endpoint` is optional and connects to a server you run yourself.
- One provider configured from the **OpenCode: Connect Provider…** panel (or with `opencode auth login`
  on a machine that has the CLI).

```sh
code --install-extension chat-for-opencode-<version>.vsix
```

From source: `npm ci && npm run compile && npx @vscode/vsce package`, or press **F5** in this
repository to launch an Extension Development Host.

## First conversation

1. Open a folder. The chat opens on first run; afterwards use the status bar icon (idle: sign in;
   running: stop; amber `?`: approval needed; finished: open chat) or the Secondary
   Side Bar icon. On VS Code 1.99–1.103 it appears in the Explorer; use _OpenCode: Move Chat View…_ to
   move it right. **Help → Welcome → Get started with OpenCode** is a four-step walkthrough.
2. Trust the folder to create the in-process OpenCode host; otherwise you get a _Trust workspace_
   action and nothing starts.
3. Type a message. `Enter` sends, `Shift+Enter` adds a line, `@` finds files, `/` finds skills and
   prompt library entries, `Esc` stops. While the agent runs, `Enter` queues and `Ctrl/Cmd+Enter`
   interrupts and sends now.
4. Pick the agent (_Build_, _Plan_, …), model and reasoning effort in the toolbar; a meter shows how
   much of the model's context the conversation uses.
5. Approve edits and shell commands from the card in the tool call or in the panel above the
   composer: **Allow once**, **Always allow** or **Reject**. Nothing is auto-approved by default.
6. Switch sessions from the top-left picker; `+` starts one, the trash deletes all after a native
   confirmation. The last session of each folder is restored when VS Code restarts.

## Features

The short version — full behaviour in [docs/FEATURES.md](docs/FEATURES.md):

- [Chat and sessions](docs/FEATURES.md#chat-and-sessions) — streaming Markdown, collapsible
  reasoning and tool cards, per-turn step folds, turn stats, a searchable session timeline, queued
  messages, subagents with a child-focused composer in the modal, `todowrite` lists.
- [Context and files](docs/FEATURES.md#context-and-files) — editor/selection chips, `@` file search,
  external files sent inline, clickable file references, prompt library, skills, replies
  saved to `AGENTS.md`.
- [Diffs and permissions](docs/FEATURES.md#diffs-and-permissions) — Apply to file with a reviewable
  native diff, changed-files panel with combined read-only diffs, permission and question cards with
  keyboard shortcuts.
- [Interface](docs/FEATURES.md#interface) — multi-root workspaces with one active connection, chat in
  the side bar or a wider editor view, provider-grouped pickers, context and cost in the status bar,
  setup-aware welcome screen.
- [Skills](docs/FEATURES.md#skills) — `/` suggestions sourced from the server, including global skills.

## Keyboard

| Action                      | Key                         |
| --------------------------- | --------------------------- |
| Search all conversations    | `Cmd/Ctrl+Alt+F`            |
| New session (chat focused)  | `Cmd/Ctrl+N`                |
| Session list (chat focused) | `Cmd/Ctrl+L`                |
| Model picker (chat focused) | `Cmd/Ctrl+M`                |
| Session timeline            | `Cmd/Ctrl+G`                |
| In-chat message search      | `Cmd/Ctrl+F`                |
| Stop / next match / resync  | `Esc` / `F3` / `Cmd/Ctrl+R` |

Every command, default key and setting: [docs/REFERENCE.md](docs/REFERENCE.md).

## How it works

- One embedded SDK host, created lazily and closed on deactivation; every workspace folder is a
  `location`. It uses OpenCode's own SQLite database under ~/.local/share/opencode (or
  $XDG_DATA_HOME), so sessions survive window reloads and are shared with the CLI/TUI. Optionally
  connect to your own `opencode.endpoint` with its password in the OS keychain.
- All calls go through OpenCode's generated client. Live events come from `events.subscribe()`;
  because that stream is live-only without replay, a resync follows every reconnect, and a
  two-second history poll folds in writes from other clients such as the TUI.
- OpenCode is the source of truth: the webview reducer is rebuilt from history and kept live by
  deltas. Details in [SPEC.md](SPEC.md), [DECISIONS.md](docs/DECISIONS.md),
  [API_NOTES.md](docs/API_NOTES.md) and [KNOWN_LIMITS.md](docs/KNOWN_LIMITS.md).

## Privacy & security

No telemetry or network calls beyond the configured server; provider credentials stay in
OpenCode. The Connect panel sends a key once, over the authenticated local connection, and never
stores or logs it in the extension. Workspace Trust gates every server and secret access, webviews
have a strict nonce CSP with sanitised Markdown, and paths from model output are confined to the
workspace.

## Development

```sh
npm ci
npm run compile    # typecheck + bundle (esbuild)
npm test           # fast local loop
npm run verify     # full CI gate: docs, audit, types, coverage, UI, integration
```

[CONTRIBUTING.md](CONTRIBUTING.md) · [docs/README.md](docs/README.md) (documentation index) ·
[docs/RELEASING.md](docs/RELEASING.md) · [MIT](LICENSE)
