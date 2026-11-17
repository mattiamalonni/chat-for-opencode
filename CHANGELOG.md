# Changelog

## Unreleased

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
