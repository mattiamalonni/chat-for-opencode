# Changelog

Legend: **`User — …`** entries change something you can see or use. **`Internal — …`** entries are
build, CI or architecture work, condensed to one line; the reasoning lives in
[DECISIONS.md](docs/DECISIONS.md) and [SPEC.md](SPEC.md).

## 0.4.1 — 2026-11-25

- **User — `/compact` command:** typing `/compact` in the composer now asks the current session to compact, just like the toolbar button and the command palette; it is listed in slash suggestions and shadows a server command with the same name. `/compact [prompt]` compacts first, then sends the optional prompt in the same conversation (with its attachments and context). A turn in progress is refused and the typed text stays in the composer.
- **User — Fork from the composer:** the per-turn fork icon is replaced by a single _Fork conversation_
  action beside _Compact_. It is available only for a loaded, idle session and copies the **full**
  history into a new branch. `/fork [prompt]` forks and immediately sends the optional prompt in the
  new branch (the composer's attachments and context go with it).
- **User — Clean fork inbox:** OpenCode's `opencode.fork-notice` plugin leaves a synthetic notice in
  each fork's inbox with `resume: false`, so it never leaves the queue. It is now hidden from the
  **Queued messages** panel while still reaching the model as context.
- **User — Removed "Save as project instruction":** the action beside _Copy response_ is gone, so a
  reply is never appended to `AGENTS.md` or another Markdown file in the workspace. The target picker,
  dated-note formatting, message type and related tests/docs were removed too.

## 0.4.0 — 2026-11-25

- **User — Session list error indicator:** sessions whose last turn failed or was interrupted now show a
  red dot (labelled _Failed_ or _Interrupted_) in the session list, next to the existing green _Running_
  and amber _Needs your input_ indicators. The red dot comes from the session history and clears as soon
  as a new prompt starts a turn. Amber still takes precedence when a request is pending.
- **Internal — Session status from history:** `sessionTurnStatus` classifies the last turn from the last
  `user`/`assistant`/`idle` message (`idle.outcome`, or an `error` on a completed assistant), ignoring
  bookkeeping messages; `SessionListService` now fetches history for every listed session, so busy and
  error states no longer depend on stale `busy`/`idle` timestamps. Pending permissions and forms remain
  live because they are not messages.
- **User — Questions stay in the chat:** a `question` tool call and its answer now remain visible in
  the conversation as a read-only card, like the assistant's prose, instead of being hidden inside a
  folded step. The data comes from the server's session history, so the card survives a VS Code reload
  and is shown when the session is opened from another workspace. While pending it keeps its usual
  tool card with the attention marker; the actionable card still lives only in the panel above the composer.
- **User — Per-workspace auto-approve:** the **Auto-approve** toggle now applies to the whole
  workspace instead of a single chat. Every permission raised by a session of that folder is granted
  once without a card, including background subagents and sessions started by another client. Turning
  it on grants requests that were already pending. Existing per-chat choices are migrated: if any
  chat in the workspace had it on, the workspace starts with it on.
- **User — Fix:** when two VS Code windows connect to the same `opencode.endpoint`, each chat now
  handles only sessions owned by its own workspace. Approval cards and turn notifications from
  another project no longer appear in the wrong editor. `opencode.autoApprovePermissions` remains the
  default for workspaces that never changed the toggle.
- **Internal — Workspace ownership:** a bounded session→directory map (fed by session lists,
  `session.created` and `parentID`) gates the shared event stream before it reaches permission cards,
  the attention overlay or turn state. Unknown ids are resolved once through `session.get`.
- **User — No external software required:** OpenCode now runs inside the extension through the
  bundled `@opencode/sdk` (2.4.1). There is no CLI to install, no `opencode serve` process, no port
  and no password for the local host. Requires VS Code 1.134+ (Node 24 in the extension host).
  `opencode.endpoint` still lets you connect to a server you run yourself.
- **Internal — SDK adapter:** `OpenCodeClient` now delegates to OpenCode's generated client instead
  of hand-written fetch/SSE; events arrive from `events.subscribe()` and a resync follows a
  reconnect. The extension entry and the bundled SDK are a single ESM file; only native/optional modules ship
  in `node_modules` (VSIX ~15 MB). A compile-time contract checks the webview's wire types against
  the SDK's generated types, and a dedicated integration suite exercises the embedded-host path.
- **Internal — Version policy:** the OpenCode version is pinned by the extension instead of the
  user's CLI, so there is no runtime version drift. Upgrading OpenCode now requires a new extension
  release. The old `executablePath` / `startupTimeout` / `autoRestart` settings are kept but ignored.
- **User — Fix:** sessions persist across VS Code reloads again. `OpenCode.create()` defaults to an
  in-memory database; the embedded host now points at OpenCode's real global database, so history is
  kept and remains visible to the CLI/TUI. Covered by a new e2e test that closes and recreates a host.
- **Internal — Tooling:** ESLint and Prettier were replaced by Oxlint and Oxfmt (`oxlint.config.ts`,
  `oxfmt.config.ts`); the `lint`, `format` and `format:check` scripts keep their names and the docs
  generator now formats through Oxfmt's API instead of Prettier's.
- **Internal — Bundle:** esbuild now emits UTF-8 characters directly instead of `\uXXXX` escapes in
  the extension and both webview bundles, saving ~260 KB from the minified `extension.mjs`.
- **Internal — Packaging:** the generated `.vscodeignore` allow-list now covers every platform variant
  declared by the SDK's optional dependencies, so the release gate passes on macOS, Linux and Windows.

## 0.3.26 — 2026-11-24

- **User — Session timeline:** `Cmd/Ctrl+G` opens a searchable timeline of the current session's turns (newest first, with steps, tokens and change counts). Selecting one scrolls to its prompt, highlights it and returns focus to the composer — the in-chat equivalent of the TUI's `session.timeline`.
- **User — Fix:** a session interrupted by a server or location shutdown no longer stays marked as
  running. When OpenCode ends a turn without writing its `idle` marker (only a completed assistant
  message with an `aborted` error), the session list and the chat treat it as idle instead of trusting
  the stale busy/idle timestamps.
- **User — Fix:** a session no longer shows the amber "Needs your input" dot in the list for a
  permission that auto-approval will grant when you open it. Background sessions kept that dot until
  opened, even though the request was granted automatically and the agent carried on. Questions still
  show it, because they always need an answer.

## 0.3.25 — 2026-11-24

- **User — External approvals:** a permission or question raised by a turn started in another client
  on the same server (for example the TUI) now appears in the approval panel, labelled with its
  session title, and can be answered from the extension. Previously those requests were dropped
  because their session was neither open nor a tracked subagent; the reply has always addressed the
  request's own session.
- **User — Subagents:** the conversation modal is no longer read-only. Its compact composer replies to
  the child session (`Enter` queues while it works, `Ctrl/Cmd+Enter` sends now) and **Stop** interrupts
  that child; the parent chat keeps its own session and draft. `send`/`abort` now accept an explicit
  `sessionId`, so commands can address a session other than the open one.
- **User — Steps:** `edit`, `read` and `write` calls now render as a single line: status, action, file icon, name and path,
  with the diff counts pushed to the right. The tool header and the changed-file row are merged, so the file is no
  longer shown twice; clicking the file name opens it, the counts open the diff, and the rest of the row folds the
  details. Extra files and the raw input/output remain in those details.
- **User — Fix:** clicking a step's file name opens it even when it lives outside the opened folders. The click is the
  explicit consent; file references in chat prose still go through the workspace-only guard.
- **User — Connect:** new **OpenCode: Connect Provider…** panel, a graphical equivalent of `/connect`,
  replaces the terminal hand-off for sign-in. Click a provider card to sign in with an API key (including
  provider-specific forms), browser OAuth, a sign-in command or external credentials. Environment-variable
  methods are hidden because they must be set on the server process. Saved accounts are listed at the top
  (active first) and can be activated, renamed or removed; one-method providers skip the method picker.
- **User — Consistency:** the status bar tooltip and **OpenCode: Account** now list every saved provider
  account from the same server API as the Connect panel, instead of showing only the built-in OpenCode login.
  Signing in or switching accounts keeps the chat connected and refreshes its model list; the Connect
  code screen closes by itself when the browser flow finishes.
- **Internal — Connect:** added integration/credential endpoints and client methods, a dedicated webview
  bundle with validated host/webview protocols, cancellation of in-flight requests when the panel closes,
  and tests (unit, UI, integration). Fixed `.vscodeignore` so the new `connect.js`/`connect.css` bundles are
  included in the VSIX.

- **User — Shortcut:** `Cmd/Ctrl+L` toggles the in-chat session list while the chat has focus (instead
  of VS Code's Expand Line Selection). `↑`/`↓` walk the sessions from the filter field, `Enter`
  selects one and focus returns to the composer; `Esc` or the shortcut closes the list. `Cmd/Ctrl+M`
  opens the model picker from the chat, and choosing a model leaves focus in the composer.
- **User — Focus:** selecting a session from a search hit (`Cmd/Ctrl+Alt+F`) leaves focus in the
  composer, ready for the next prompt.
- **User — Removed:** the **OpenCode: Focus Chat** (`Cmd/Ctrl+Alt+O`) and **OpenCode: Ask OpenCode…**
  (`Cmd/Ctrl+Alt+Shift+O`) commands are gone. The status bar icons and the walkthrough now focus the
  chat view directly; the composer is still reachable by clicking it or using the OpenCode view icon.
- **User — Removed:** **OpenCode: Quick Switch Session** (`Cmd/Ctrl+Alt+L`) and its recent-session
  picker are gone. Switch conversations from the session list in the chat (`Cmd/Ctrl+L`) or search
  all conversations with `Cmd/Ctrl+Alt+F`.

## 0.3.24 — 2026-11-24

- **User — Fix:** an empty model list from OpenCode 2.4's lazily booted providers no longer produces
  an immediate "No model provider is configured" error. The extension retries the catalog a few
  times before treating it as a real setup problem, so the chat connects as soon as the server's
  model snapshot settles.
- **User — Version banner:** dismissing the untested-version warning now sticks for the whole minor
  series (e.g. 2.4.x), not just the exact patch release that was running when you dismissed it.
- **User — OpenCode 2.4.0:** the supported server version, OpenAPI snapshot and generated wire types
  are now based on 2.4.0. The contract is additive over 2.3.0 for the endpoints the extension uses;
  servers on another minor still show the dismissible version banner.

## Older releases

Releases before 0.3.24 are documented in [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).
At tag time each release's notes were generated from this file, so no history was lost when the
older sections were retired. The release workflow still needs the `## X.Y.Z — date` section of the
version being published; see [docs/RELEASING.md](docs/RELEASING.md).
