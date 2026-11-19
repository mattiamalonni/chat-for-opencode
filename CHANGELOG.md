# Changelog

## 0.3.15 — 2026-11-19

- Removed the **OpenCode: Show Changed Files** command from the chat view title bar (the changed-files
  panel inside the chat is unchanged).
- Fixed **Move Chat View…**: it now uses VS Code's view picker, which passes the chat view explicitly
  to the move command, instead of erroring with "There is no view currently focused" when invoked
  from the view's overflow menu (webview focus clears VS Code's internal `focusedView` key).

## 0.3.14 — 2026-11-19

- Finished turns now fold thoughts and tool calls into **expandable per-step details** while prose
  stays visible. Consecutive textless steps of the same reasoning run merge into one collapsible
  block, which opens into a timeline-style layout.
- Step details appear **above the text they produced**, so no thought is shown after the final
  answer. Fold headers show only the step label, and the turn summary bar reports the total number
  of steps.

## 0.3.13 — 2026-11-19

- The chat now tops up incrementally from the server when the panel becomes visible again, and a
  **sync icon** next to the Markdown export reloads the conversation authoritatively on demand. This
  repairs a chat whose live state drifted from the server (e.g. events missed during a disconnect).
- Removed message virtualization: every message is now rendered in the DOM instead of just the
  scrolled window, so scrolling no longer depends on estimated row heights or reserved padding.
- Drag & drop into the chat can now be turned off with the new `opencode.dropzone` setting (enabled
  by default), useful when VS Code's default drop behaviour interferes with the chat. The change is
  applied live, without reloading the window.
- Hardened connection, server lifecycle and webview correctness: stale connection attempts are
  invalidated on folder switches and reconnects, orphan cleanup verifies PID/port ownership before
  killing, and a shared startup deadline and restart promise avoid duplicate managed servers. The
  webview now uses shell-injection-safe executable paths, sanitizes Markdown before linkifying,
  confines file references to the workspace, deduplicates permission replies and notices, and fixes
  mixed drops, numeric inputs, mention clamping and accessibility announcements.

## 0.3.12 — 2026-11-19

- Subagent activity now appears **inline in the conversation**: the subagent tool card stays on one
  line (agent, description, live activity and elapsed time) and expands on demand into a compact
  timeline with the task and final report. Background subagents are supported too, including their
  late reports.
- The session list has a discreet trash icon next to **+ New Session** (aligned right) to delete all
  sessions, confirmed by a native VS Code dialog. It removes every session in the workspace folder
  (not just the loaded page), clears their drafts and per-chat settings, and leaves an empty chat
  ready for a new prompt.
- Fixed the chat snapping back to the bottom on unrelated re-renders (tooltips, context updates or
  virtual window changes); it now pins to the bottom only when the conversation actually grows.
- Streaming and rendering were optimized: adjacent deltas are coalesced before reducing and turn
  merging is now linear, so long conversations stay responsive while the agent streams. Resource
  cleanup and event guards were tightened so malformed payloads cannot blank the chat view.

## 0.3.11 — 2026-11-19

- Finished turns show a compact footer with the wall-clock duration, total tokens and cost for the
  whole turn (details in the tooltip).
- The session picker pages at 10 entries by default (`opencode.sessionPageSize`): it closes on an
  outside click, the header trigger distinguishes the session list from the current chat, and the
  rename and delete confirmations share the same aligned card layout.
- A finished turn now folds its intermediate steps (thinking, tool calls and narration), including
  the reasoning attached to the final answer, into a single expandable "Show N steps" row — leaving
  only the final answer visible. During streaming nothing is hidden, and searching a session expands
  the folded steps automatically.
- Messages can be **queued** while the agent works (plain Enter) or sent as a **steer** that
  interrupts the current answer (Ctrl/Cmd+Enter), using OpenCode's `delivery` field.
- Composer drafts now survive a window reload (per session, in `workspaceState`).
- Permission cards respond to `1`/`2`/`3`; the header can export the conversation as Markdown and
  search messages in the current session; long conversations are windowed for rendering.
- The context meter includes a `~`-marked estimate for inline attachments.
- ChatController extracted `CatalogService`, `PermissionService` and a `Generation` token; file
  mentions cache their index in `workspaceState`.
- CI runs VS Code integration on Linux, macOS and Windows for every PR. New
  `test:integration:real:e2e` combines real webview clicks with a real server; accessibility-tree
  checks were added to the UI suite.
- Reconnects and post-turn reconciles now fetch only the new tail of the conversation and merge it
  by message id, instead of rebuilding the whole chat. Scroll position, staged attachments and
  drafts survive a resync.
- Each session keeps its own composer draft.
- Raw server payloads pass through a normalising adapter; the raw types it consumes are generated
  from the OpenAPI snapshot and checked in CI.
- Slash suggestions and file mentions now respect VS Code's `search.exclude` / `files.exclude`.
- Webview language follows `vscode.env.language`; server PID records are keyed by folder and owning
  window so two VS Code windows on the same folder no longer overwrite each other.
- CI runs lint, build and unit tests on Linux, macOS and Windows; a new
  `test:integration:e2e` suite clicks the real webview inside VS Code over CDP.

## 0.3.10 — 2026-11-18

- The composer's **Auto-approve** toggle, **Compact** button and context meter now share the
  file-picker row at the bottom, leaving the toolbar free for the model and agent pickers. On a
  narrow side bar the toggle and the drop hint collapse to icons.
- Tooltips use the VS Code UI font and a stable natural width, so they render consistently across
  controls.

## 0.3.9 — 2026-11-18

- Fixed a horizontal scrollbar with empty space on the right of the chat: tooltips on context chips
  near the right edge could extend past the view even while hidden. Tooltips now wrap and grow
  towards whichever side has room.

## 0.3.8 — 2026-11-18

- The `/` picker now includes OpenCode **commands** alongside skills and runs them through the
  server's command endpoint.
- **Slash suggestions** are populated on a fresh window or right after *New session*, and refresh
  when OpenCode registers or removes skills/commands while the chat is open. The highlighted row
  stays visible while navigating a long list with the keyboard.

## 0.3.7 — 2026-11-18

- Images and other files **pasted into the prompt** (for example a screenshot from the clipboard)
  are now attached as chips and sent with the message, just like dropped or picked files. Plain-text
  pastes are unaffected.
- Added a compact **Build / Plan** dropdown in the composer toolbar to switch between OpenCode's two
  built-in agents. It starts in **Build** mode by default and stays available even when the server
  does not expose the agent list; the full agent picker remains next to it for custom agents.
- The composer's **@** toolbar button was removed (typing `@` still opens file/skill suggestions);
  the folder button now sits in the file drop hint, next to the drag-and-paste prompt.

## 0.3.6 — 2026-11-18

- The **Changed files** panel now has a check button next to Refresh to mark the current changes as
  reviewed and hide the section. It reappears automatically when the changed files change or a
  different session is loaded.
- `Cmd/Ctrl+N` now starts a **new session** while the chat view has focus, instead of VS Code's
  "New Untitled File". Outside the chat the shortcut keeps its normal VS Code behaviour.
- Files can now be **dragged into the chat from outside** (desktop, file manager or another VS Code
  view) and are attached as chips. VS Code only delivers these drops while **Shift** is held, so the
  composer shows a hint; the new folder button opens a **native file picker** as an alternative.
  Files outside the workspace are attached as `data:` URLs, so the model receives their content
  directly instead of a path it has to look for on disk.
- **Clickable file references**: paths in the conversation (`src/app.ts:42`, `foo.ts#L7`), tool
  inputs, permission resources and changed-file rows now open the file in the editor at the exact
  line, instead of being copied by hand. Numbers, version strings and IP addresses are no longer
  mistaken for paths.
- Tooltips on icon buttons now appear instantly instead of after the native delay, and the
  changed-files **Refresh** control is clearer (renamed *Refresh changed files*, new icon).
- Added a runtime **contract smoke test**: on connect the extension checks the shape of the data it
  actually receives (server version, models, agents, skills, history, context window, diff) and a
  dismissible banner names the features that will not work with the connected server.
- New **OpenCode: Compact Conversation** command and composer button, backed by the server's
  `POST /api/session/{id}/compact` endpoint.
- Orphaned `opencode serve` processes left behind by a VS Code crash are now reaped on the next
  start. PID records are kept in global storage and contain no password; servers owned by another
  live VS Code window are left alone.
- The changed-files panel now also lists paths reported by a step when neither the diff endpoint
  nor tool metadata carries a patch (no diff can be opened for those rows).
- CI now runs the VS Code integration suite on Windows and macOS in addition to Linux.
- Fixed stale version numbers in the install instructions.

## 0.3.5 — 2026-11-18

- The UI is now **English-only**: removed the Italian translation bundles. The VS Code localization layer is kept for future translations.
- **Sessions** can be renamed from the session menu, and *Load more sessions* reaches older ones
  beyond the first page of 50.
- The session list shows live status: a pulsing green dot for a running session and an amber
  **Needs your input** dot when it is paused on a question or permission request.
- Question forms have a cleaner layout, with more spacing around the title, fields and buttons.
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
- If sending a permission or question reply fails, the card's buttons are re-enabled so you can
  retry instead of being left with a disabled card.
- Modified **↑/↓** keys (Cmd/Ctrl/Alt) no longer trigger prompt-history recall, preserving the
  standard caret shortcuts.

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
