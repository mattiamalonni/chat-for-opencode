# Changelog

## Unreleased

- The UI is now **English-only**: removed the Italian translation bundles. The VS Code localization layer is kept for future translations.
- **Sessions** can be renamed from the session menu, and *Load more sessions* reaches older ones
  beyond the first page of 50.
- The **changed-files panel** now falls back to patches recorded by completed tools, so it also works
  outside git repositories (where `GET /session/{id}/diff` is empty).
- The session **cost** reported by OpenCode is shown in the composer's context meter tooltip.
- Fixed stale attachments/chips and changed-files panel when switching workspace folder or session;
  loading the same session again (a resync) no longer discards them.
- The composer draft is flushed when the chat view is hidden or reloaded, so the last keystrokes are
  not lost to the save debounce.
- Session cost and token usage are restored from history on reload/resync instead of disappearing
  after every turn.
- Fixed a trailing multi-byte UTF-8 character being dropped when an SSE stream ended mid-character.
- Opening more than 200 virtual diffs no longer risks blanking a diff tab that is still open.
- Removed an unused external-server failure path.
- Fixed the composer staying on **Stop** after cancelling a question: dismissing a form now clears
  the session's busy state locally, so a new prompt can be sent even when OpenCode emits no terminal
  execution event.

## 0.3.4 — 2026-11-18

- Press **↑** / **↓** in the composer to recall prompts already sent in the current session
  (shell-style history); editing a recalled prompt starts a fresh draft.
- Fixed the composer getting stuck on **Stop** after interrupting a session. OpenCode can leave a
  session's `busy` timestamp newer than `idle` after an interrupt; the post-turn refresh now trusts
  the terminal message in the history, so the send button becomes available again and further
  messages can be sent. Clicking **Stop** on an already-idle session also resets the button locally.

## 0.3.3 — 2026-11-18

**Behaviour change**

- **Auto context** now shows the active file as a chip but attaches it to a message only when you
  click its **+** button; the selection stays attached automatically. Chips can be toggled on/off
  with **+** / ×. Disable `opencode.autoContext` to hide both chips. Previously both were attached
  automatically and a chip could only be removed.

- New `opencode.autoApprovePermissions` setting (off by default): when enabled, every inline
  permission request (edits, shell commands, access outside the workspace) is granted once on
  arrival instead of showing a card. Saved rules are untouched.
- The composer has an **Auto-approve** toggle next to the context meter to turn this on for a single
  chat; the per-chat choice is remembered, while the setting remains the default for new chats.
- New **OpenCode: Account** command and a clickable status bar icon to view saved OpenCode logins
  (the tooltip lists them) and sign in via `opencode auth login` without leaving VS Code.
- Tool calls are grouped in a compact card per step, context chips and attachments show file-type
  icons, and a **Jump to latest** button appears after scrolling up during a response.
- The chat view shows a **Reload chat** action if it stops working instead of going blank, and
  re-reads a finished turn's history so a missed live event can't leave a response stuck.
- Fixed attachments delivered by the live stream without a top-level `uri`; malformed payloads no
  longer make the chat crash.

## 0.3.2 — 2026-11-17

- The composer suggests available OpenCode skills when typing `/`. Selecting a skill adds its
  slash command; before sending, the extension translates it to OpenCode's `@skill-id` syntax so
  the server loads the skill with the prompt. Other slash commands are unchanged.
- Skills are loaded from OpenCode's default location so global skills are included, and only their
  ID, name and description are sent to the webview.

## 0.3.1 — 2026-11-17

- Question options now show the title above its description in a single column, with a larger
  click target, instead of squeezing them side by side.

## 0.3.0 — 2026-11-17

- The model picker shows each model's context window (e.g. `200K`, `1M`).
- A context meter next to the send button shows how much of the selected model's context window
  the conversation uses (percentage, turns amber at 75% and red at 90%; exact counts in the tooltip).
- The chat now warns when the connected OpenCode version differs from the one tested (2.2.x):
  a dismissible banner distinguishes untested minor versions from unsupported major versions and
  links to the issue tracker. Patch releases (2.2.*) don't warn, and a dismissed warning stays
  hidden for that server version across reloads.

## 0.2.0 — 2026-11-16

**Behaviour change**

- New sessions now ask for approval before edits, shell commands and access outside the workspace
  by default; OpenCode's base policy silently allowed them. Set `opencode.sessionPermissions` to
  `[]` to restore the previous behaviour.
- Session rules take precedence over the `permissions` in `opencode.json`: if you keep an allowlist
  there, copy it into `opencode.sessionPermissions` or set that option to `[]`.

## 0.1.1 — 2026-11-16

- Repository renamed to `mattiamalonni/chat-for-opencode`; Marketplace links (repository, issues, homepage) updated.

## 0.1.0 — 2026-11-16

- The chat view now lives in the **Secondary Side Bar** (right, like Copilot Chat) on VS Code 1.104+.
- Activates on startup, reveals the chat on first run and adds an **OpenCode** status bar entry
  (the Secondary Side Bar is closed by default, so the view was easy to miss).
- New command *OpenCode: Move Chat View…* (also in the view's `…` menu).
- Custom themed pickers for agent, model (searchable, grouped by provider), reasoning effort and
  workspace folder, replacing native `<select>`s; composer redesigned as a single input box.

Initial release.

- Sidebar chat (Webview View) for OpenCode v2 (`opencode serve`), tested with OpenCode 2.2.7.
- Managed server per workspace folder (dynamic port, random password, health check, auto-restart,
  clean shutdown) or external server via `opencode.endpoint` + SecretStorage password.
- SSE streaming with automatic reconnect and resync; Markdown with highlighting; collapsible reasoning;
  generic tool cards.
- Sessions: list, create, switch, resume (persisted per folder), delete.
- Model / reasoning-effort / agent selectors from the server catalog; stop button.
- Active file + selection context chips, `@` file mentions, *Add Selection/File to Chat* commands.
- Native diff editor for proposed and applied changes; changed-files panel.
- Inline permission requests and question forms (never auto-approved); todo list from `todowrite`.
- Actionable error banners, keyboard isolation from VS Code shortcuts, IME-safe input, ARIA labels.
- English and Italian localisation.
