# Changelog

Legend: **`User — …`** entries change something you can see or use. **`Internal — …`** entries are
build, CI or architecture work, condensed to one line; the reasoning lives in
[DECISIONS.md](docs/DECISIONS.md) and [SPEC.md](SPEC.md).

## Unreleased

- **User — Shortcut:** `Cmd/Ctrl+L` toggles the in-chat session list while the chat has focus (instead
  of VS Code's Expand Line Selection). `↑`/`↓` walk the sessions from the filter field, `Enter`
  selects one and focus returns to the composer; `Esc` or the shortcut closes the list.

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

## 0.3.21 — 2026-11-22

- **User — UI:** the finished-turn footer now shows the turn's start and end times (`HH:mm`, local time) at
  its two ends, flanking the existing steps, duration, tokens and cost. Both times are in the bar's
  accessible label too.
- **User — UI:** new first-run walkthrough (**Help → Welcome → Get started with OpenCode**) plus a setup-aware
  empty state. The Install action shows a copyable, OS-aware command with a retry instead of a bare
  docs link, provider sign-in explains the terminal hand-off before it happens, and setup-blocking
  error details are shown inline instead of behind a collapsed _Details_ toggle.
- **User — UI:** `Cmd/Ctrl+Alt+S` opens a single-modal quick switcher: recent sessions appear immediately,
  typing searches all conversations in the same picker, and the chat search dims non-matches, jumps
  to the first hit while typing and keeps its query per session.
- **User — UI:** the status bar now distinguishes `$(question)` / amber _needs your input_ from a running
  turn; clicking it opens the approval instead of stopping the turn. The latest finished turn keeps
  its steps expanded with an expand/collapse-all control, the changed-files panel opens by default,
  and _View all changes_ uses the native multi-file diff with a hunk-only fallback.
- **User — UI:** the subagent dialog traps focus and restores it to its trigger; step status dots carry an
  icon and accessible name. One `--opencode-border` token guarantees boundaries in high-contrast and
  `prefers-contrast: more` themes, and muted text no longer relies on opacity below contrast limits.
- **User — UI:** search hits all use the same theme find-match background colour and mark only the text
  background — no outline or underline. Markdown stays fully rendered while
  searching — matches are marked inside the parsed HTML, so `**bold**` is no longer shown raw — and
  Escape now closes _and_ clears the query, restoring the undimmed conversation. Changed-file rows
  now offer only the diff action: the extra "open file" icon was removed.
- **User — Fix:** _View all session changes_ now really opens the native multi-file diff: `vscode.changes`
  needs `[resource, original, modified]` triples, and the previous two-element pairs silently fell
  back to the single hunk-only diff.
- **User — Fix:** the search toggle's tooltip no longer covers the search input on narrow side bars.
- **User — UI:** jumping between search matches is instant instead of smoothly animated.
- **User — Fix:** an authoritative inbox snapshot now flushes queued events before reconciling. Previously a
  prompt whose `inbox.enqueued` event was still waiting for the next animation frame could be
  resurrected by the snapshot and then delivered twice by `execution.started`.
- **User — Setting:** `opencode.toolOutputLimit` (default `4000`) controls how much tool output is shown
  inline before the _output (n)_ expander.
- **User — UI:** _Ask OpenCode…_ now fills the composer with the current editor selection attached instead
  of sending a single-line prompt immediately; the text can be reviewed before it reaches the agent.
  _Copy response_ copies only the visible reply text, not tool I/O and reasoning.
- **User — UI:** chat search now highlights matches in replies and tool cards, with next/previous navigation
  (`Enter`, `F3`, `Shift+F3`) and an “N of M” counter. The session list can be filtered by title and
  navigated with ↑/↓/Enter.
- **User — UI:** the status bar is actionable: click it to stop a running turn, open the chat when it ends,
  or manage logins when idle; the tooltip reflects the current state.
- **User — Robustness:** disposing the controller now uses the hard detach, invalidating the connect
  generation so an in-flight `server.ensure()` can no longer reopen an SSE stream and poll timer
  after teardown. Folder switches clear the pending connect too.
- **User — Robustness:** one invalidation path now covers every connection/session change (generations,
  timers, abort controllers, permissions, execution and picker). All long history/catalog fetches
  carry a connection-scoped `AbortSignal`, so switching folder or session stops the requests instead
  of only discarding their results.
- **User — Robustness:** `EventStream` is safe to close and restart while a fetch is in flight: a stale
  read loop can no longer schedule a second reconnect chain or duplicate events.
- **User — Fix:** starting a new session no longer cancels an in-flight _Delete all sessions_ walk. Only a
  folder switch, server reset or shutdown stops the bulk delete now — server events may legitimately
  open a session while the walk is in progress.
- **Internal — Architecture:** `ChatCommandHandler` no longer imports the VS Code runtime; confirmations, clipboard and workspace lookup go through host hooks.
- **Internal — DX:** Integration tests share the repo's strict typecheck; Vitest, Dependabot and the production smoke test were tightened.
- **User — Fix:** retry jitter is now symmetric (−50%…+50%) as documented, instead of −50%…0%.

## Older releases

Releases before 0.3.21 are documented in [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).
At tag time each release's notes were generated from this file, so no history was lost when the
older sections were retired. The release workflow still needs the `## X.Y.Z — date` section of the
version being published; see [docs/RELEASING.md](docs/RELEASING.md).
