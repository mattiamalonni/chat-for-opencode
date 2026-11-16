# Changelog

## Unreleased

- The chat view now lives in the **Secondary Side Bar** (right, like Copilot Chat) on VS Code 1.104+.
- New command *OpenCode: Move Chat View…* (also in the view's `…` menu).
- Custom themed pickers for agent, model (searchable, grouped by provider), reasoning effort and
  workspace folder, replacing native `<select>`s; composer redesigned as a single input box.

## 0.1.0 — 2026-11-16

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
