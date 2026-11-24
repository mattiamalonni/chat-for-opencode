# Changelog

Legend: **`User — …`** entries change something you can see or use. **`Internal — …`** entries are
build, CI or architecture work, condensed to one line; the reasoning lives in
[DECISIONS.md](docs/DECISIONS.md) and [SPEC.md](SPEC.md).

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

## 0.3.23 — 2026-11-23

- **User — Removed:** the on-demand context sources (`problems`, `git`, `terminal`, `openEditors`,
  `symbol`) are gone: no `#` picker, no **Add context** button, no inline content chips, and no
  `contextSources` / `addContextSource` / `removeContextSource` messages. The `$diff` and `$problems`
  prompt variables still work — they are resolved directly into the prompt text. `@` remains the
  trigger for workspace files, and `/` for skills, prompts and commands.
- **User — UI:** the **Changed files** panel now starts folded. Its header, file totals and actions stay
  visible, but the file list is revealed only when you open it, and your choice is kept while the chat
  re-renders.

## 0.3.22 — 2026-11-23

- **User — Fix:** step folds now follow the turn lifecycle consistently. While a reply streams, only its
  current step is expanded; when the turn ends, every fold closes — including the last step's — while
  the answer's prose stays visible. Fold overrides are keyed per turn, so expanding or collapsing one
  reply no longer leaks into the next one's automatic state. Regression-tested in the UI suite.
- **User — Removed:** the chat toolbar's _Open OpenCode Config File_ button and its `opencode.openConfigFile`
  command are gone, along with the dedicated config endpoint call and path validation they needed.
  OpenCode config files can still be edited directly in the workspace.

- **User — OpenCode 2.3.0:** the supported server version, OpenAPI snapshot and generated wire types are
  now based on 2.3.0. The API contract is additive over 2.2.7 (new event types and optional fields),
  so recorded 2.2.7 fixtures and CI's live contract job keep covering the same endpoints. Servers on
  another minor still show the dismissible version banner.
- **User — Multi-root:** `@` file search now indexes **every** workspace folder and qualifies duplicate
  names with the folder name, so files unique to another package are suggested too. Files from any
  open folder can be attached, opened from a reply and shown in a diff (the real-path containment
  check now accepts all opened folders, still blocking `../` escapes and symlinks). Session rows
  carry their folder name when more than one folder is open, and adding or removing a folder
  refreshes the index and the folder picker. One folder remains actively connected at a time.
- **User — Editor:** a finished reply can be saved as a project instruction with the new action next to
  **Copy response**. It appends a dated Markdown section to `AGENTS.md` (or a file you choose in the
  workspace), skips notes already present, caps long replies at 2 000 characters and never writes
  outside the connected folder.
- **User — Prompts:** a reusable prompt library is available from `/` alongside skills and commands. Eight
  curated prompts ship with the extension (explain, tests, bugs, optimize, document, review,
  problems, commit) and users can add their own via `opencode.promptLibrary`. Selecting one prefills
  the composer with `$selection`, `$file`, `$diff` and `$problems` resolved from the current editor
  and context sources; it is never sent automatically.
- **User — Editor:** every code block in a reply now has an **Apply to file** button. It uses the nearest
  file reference in the reply (or asks you to pick one), opens a native diff of the proposed content,
  and writes the file only after you press **Accept** in the confirmation notification. Full-file
  blocks replace the file; unified diff blocks are applied as patches. Paths are confined to the
  connected workspace, and an invalid patch is rejected before any diff is shown.
- **User — Context:** five on-demand context sources can be attached as chips: `@problems` (diagnostics of
  the active file), `@git` (uncommitted diff), `@terminal` (last command output), `@openEditors` and
  `@symbol` (definitions at the cursor). They are available from the `@` suggestions and from a new
  **Add context** button in the composer; content travels to the model as an inline Markdown data
  URI, so it works with both managed and external servers. Chips are attached by default and can be
  removed; the catalog and add/remove messages are guarded and covered by unit, UI and integration tests.
- **User — UI:** a second status bar item (`opencode.showUsageInStatusBar`, default on) shows the session's
  estimated context size and cost, fed by the server's `session` / `sessionDelta` usage payloads. It
  hides until OpenCode reports numbers, survives resyncs that omit usage, and clears when the session
  closes. Its tooltip carries the input/output/reasoning/cache breakdown.
- **User — UI:** the finished-turn footer leads with the friendly name of the model that started the turn
  (the first step's model, so a later switch does not change it).
- **User — Fix:** in narrow panels the finished-turn footer stays on one line and ellipsizes instead of
  widening the conversation's horizontal scroll area; the clock times drop out below 180px.

## Older releases

Releases before 0.3.22 are documented in [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).
At tag time each release's notes were generated from this file, so no history was lost when the
older sections were retired. The release workflow still needs the `## X.Y.Z — date` section of the
version being published; see [docs/RELEASING.md](docs/RELEASING.md).
