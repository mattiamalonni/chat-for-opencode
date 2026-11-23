# Changelog

## 0.3.22 — 2026-11-23

- **Fix:** step folds now follow the turn lifecycle consistently. While a reply streams, only its
  current step is expanded; when the turn ends, every fold closes — including the last step's — while
  the answer's prose stays visible. Fold overrides are keyed per turn, so expanding or collapsing one
  reply no longer leaks into the next one's automatic state. Regression-tested in the UI suite.
- **Removed:** the chat toolbar's _Open OpenCode Config File_ button and its `opencode.openConfigFile`
  command are gone, along with the dedicated config endpoint call and path validation they needed.
  OpenCode config files can still be edited directly in the workspace.

- **OpenCode 2.3.0:** the supported server version, OpenAPI snapshot and generated wire types are
  now based on 2.3.0. The API contract is additive over 2.2.7 (new event types and optional fields),
  so recorded 2.2.7 fixtures and CI's live contract job keep covering the same endpoints. Servers on
  another minor still show the dismissible version banner.
- **Multi-root:** `@` file search now indexes **every** workspace folder and qualifies duplicate
  names with the folder name, so files unique to another package are suggested too. Files from any
  open folder can be attached, opened from a reply and shown in a diff (the real-path containment
  check now accepts all opened folders, still blocking `../` escapes and symlinks). Session rows
  carry their folder name when more than one folder is open, and adding or removing a folder
  refreshes the index and the folder picker. One folder remains actively connected at a time.
- **Editor:** a finished reply can be saved as a project instruction with the new action next to
  **Copy response**. It appends a dated Markdown section to `AGENTS.md` (or a file you choose in the
  workspace), skips notes already present, caps long replies at 2 000 characters and never writes
  outside the connected folder.
- **Prompts:** a reusable prompt library is available from `/` alongside skills and commands. Eight
  curated prompts ship with the extension (explain, tests, bugs, optimize, document, review,
  problems, commit) and users can add their own via `opencode.promptLibrary`. Selecting one prefills
  the composer with `$selection`, `$file`, `$diff` and `$problems` resolved from the current editor
  and context sources; it is never sent automatically.
- **Editor:** every code block in a reply now has an **Apply to file** button. It uses the nearest
  file reference in the reply (or asks you to pick one), opens a native diff of the proposed content,
  and writes the file only after you press **Accept** in the confirmation notification. Full-file
  blocks replace the file; unified diff blocks are applied as patches. Paths are confined to the
  connected workspace, and an invalid patch is rejected before any diff is shown.
- **Context:** five on-demand context sources can be attached as chips: `@problems` (diagnostics of
  the active file), `@git` (uncommitted diff), `@terminal` (last command output), `@openEditors` and
  `@symbol` (definitions at the cursor). They are available from the `@` suggestions and from a new
  **Add context** button in the composer; content travels to the model as an inline Markdown data
  URI, so it works with both managed and external servers. Chips are attached by default and can be
  removed; the catalog and add/remove messages are guarded and covered by unit, UI and integration tests.
- **Commands:** _OpenCode: Continue This Session in Terminal_ opens a terminal in the workspace and
  runs `opencode --session <id>` for the open conversation (or a fresh TUI when none is open). The
  executable path and session id are shell-quoted per platform, and a warning appears if the chat is
  still generating. The pure command builder is unit-tested on POSIX and Windows.
- **UI:** a second status bar item (`opencode.showUsageInStatusBar`, default on) shows the session's
  estimated context size and cost, fed by the server's `session` / `sessionDelta` usage payloads. It
  hides until OpenCode reports numbers, survives resyncs that omit usage, and clears when the session
  closes. Its tooltip carries the input/output/reasoning/cache breakdown.
- **Commands:** _OpenCode: Review My Changes_ and _OpenCode: Write Commit Message_ read the workspace's
  staged + unstaged git diff and send it to the agent with a purpose-built prompt (review checklist,
  or a Conventional Commit message to paste into SCM). Untracked files are named in the prompt, the
  diff is capped at 24 000 characters, and repositories without commits use a staged/unstaged fallback.
- **Editor:** `vscode.languages.registerCodeActionsProvider` adds _Fix with OpenCode_ (preferred) and
  _Explain with OpenCode_ Quick Fixes for diagnostics that touch the cursor/selection, up to three
  at a time. Each one selects the offending lines and prefills the chat with the diagnostic message —
  it never sends on its own. A new editor title button, _Ask OpenCode About This File_, attaches the
  whole file with a starter prompt. Verified with a real diagnostic collection and
  `vscode.executeCodeActionProvider` in the integration suite.
- **UI:** the finished-turn footer leads with the friendly name of the model that started the turn
  (the first step's model, so a later switch does not change it).
- **Fix:** in narrow panels the finished-turn footer stays on one line and ellipsizes instead of
  widening the conversation's horizontal scroll area; the clock times drop out below 180px.

## 0.3.21 — 2026-11-22

- **UI:** the finished-turn footer now shows the turn's start and end times (`HH:mm`, local time) at
  its two ends, flanking the existing steps, duration, tokens and cost. Both times are in the bar's
  accessible label too.
- **UI:** new first-run walkthrough (**Help → Welcome → Get started with OpenCode**) plus a setup-aware
  empty state. The Install action shows a copyable, OS-aware command with a retry instead of a bare
  docs link, provider sign-in explains the terminal hand-off before it happens, and setup-blocking
  error details are shown inline instead of behind a collapsed _Details_ toggle.
- **UI:** `Cmd/Ctrl+Alt+S` opens a single-modal quick switcher: recent sessions appear immediately,
  typing searches all conversations in the same picker, and the chat search dims non-matches, jumps
  to the first hit while typing and keeps its query per session.
- **UI:** the status bar now distinguishes `$(question)` / amber _needs your input_ from a running
  turn; clicking it opens the approval instead of stopping the turn. The latest finished turn keeps
  its steps expanded with an expand/collapse-all control, the changed-files panel opens by default,
  and _View all changes_ uses the native multi-file diff with a hunk-only fallback.
- **UI:** the subagent dialog traps focus and restores it to its trigger; step status dots carry an
  icon and accessible name. One `--opencode-border` token guarantees boundaries in high-contrast and
  `prefers-contrast: more` themes, and muted text no longer relies on opacity below contrast limits.
- **UI:** search hits all use the same theme find-match background colour and mark only the text
  background — no outline or underline. Markdown stays fully rendered while
  searching — matches are marked inside the parsed HTML, so `**bold**` is no longer shown raw — and
  Escape now closes _and_ clears the query, restoring the undimmed conversation. Changed-file rows
  now offer only the diff action: the extra "open file" icon was removed.
- **Fix:** _View all session changes_ now really opens the native multi-file diff: `vscode.changes`
  needs `[resource, original, modified]` triples, and the previous two-element pairs silently fell
  back to the single hunk-only diff.
- **Fix:** the search toggle's tooltip no longer covers the search input on narrow side bars.
- **UI:** jumping between search matches is instant instead of smoothly animated.
- **Fix:** an authoritative inbox snapshot now flushes queued events before reconciling. Previously a
  prompt whose `inbox.enqueued` event was still waiting for the next animation frame could be
  resurrected by the snapshot and then delivered twice by `execution.started`.
- **Setting:** `opencode.toolOutputLimit` (default `4000`) controls how much tool output is shown
  inline before the _output (n)_ expander.
- **UI:** _Ask OpenCode…_ now fills the composer with the current editor selection attached instead
  of sending a single-line prompt immediately; the text can be reviewed before it reaches the agent.
  _Copy response_ copies only the visible reply text, not tool I/O and reasoning.
- **UI:** chat search now highlights matches in replies and tool cards, with next/previous navigation
  (`Enter`, `F3`, `Shift+F3`) and an “N of M” counter. The session list can be filtered by title and
  navigated with ↑/↓/Enter.
- **UI:** the status bar is actionable: click it to stop a running turn, open the chat when it ends,
  or manage logins when idle; the tooltip reflects the current state.
- **Robustness:** disposing the controller now uses the hard detach, invalidating the connect
  generation so an in-flight `server.ensure()` can no longer reopen an SSE stream and poll timer
  after teardown. Folder switches clear the pending connect too.
- **Robustness:** one invalidation path now covers every connection/session change (generations,
  timers, abort controllers, permissions, execution and picker). All long history/catalog fetches
  carry a connection-scoped `AbortSignal`, so switching folder or session stops the requests instead
  of only discarding their results.
- **Robustness:** `EventStream` is safe to close and restart while a fetch is in flight: a stale
  read loop can no longer schedule a second reconnect chain or duplicate events.
- **Fix:** starting a new session no longer cancels an in-flight _Delete all sessions_ walk. Only a
  folder switch, server reset or shutdown stops the bulk delete now — server events may legitimately
  open a session while the walk is in progress.
- **Architecture:** `ChatCommandHandler` no longer imports the VS Code runtime. Confirmations,
  clipboard and workspace lookup go through host hooks, and the synthetic events no longer use
  `as never` / `as ServerEvent` casts.
- **DX:** integration tests are typechecked with the same strict settings as the rest of the repo;
  Vitest and its coverage provider are pinned to the same version; Dependabot now proposes major
  updates as well. CI no longer reruns the contract snapshot on every matrix runner, and the
  production smoke test now asserts that the shipped artefact really is minified and map-free.
- **Fix:** retry jitter is now symmetric (−50%…+50%) as documented, instead of −50%…0%.

## 0.3.20 — 2026-11-22

- **Architecture:** webview command dispatch moved out of `ChatController` into `ChatCommandHandler`.
  Together with the earlier `ChatEventRouter`, both large dispatch switches are now standalone
  services with explicit hooks boundaries, covered by unit tests that need no VS Code host. Shared
  storage keys live in `src/chat/storageKeys.ts`; the controller only wires the services together.
- **Architecture:** server-event routing moved out of `ChatController` into `ChatEventRouter` with an
  explicit hooks boundary. Subagent discovery/linking, inbox scheduling, turn lifecycle, hidden
  notifications and picker refreshes are now unit-testable without a VS Code host; the controller
  only wires the router to its services.
- **UI:** the _Copy response_ action is now docked beside the first line of the answer and revealed
  on hover/focus, instead of floating in the empty bottom-right corner of tall grouped messages.
- **Robustness:** the set that suppresses duplicate notifications while the chat is hidden is now
  FIFO-bounded (500 keys), like the other caches in the extension. A long session with the chat
  closed can no longer grow it without limit.
- **Fix:** queued prompts are now reconciled with the server's inbox list after a resync. If a
  `delivered`/`cancelled` event was lost while reconnecting, the stale queued card and its turn id
  are dropped, so the next `execution.started` cannot duplicate the prompt in the conversation.
- **Fix:** the webview error boundary no longer stays in its crashed state forever. A fresh `session`
  payload or a completed resync retries the render with the new data; manual reload is still offered
  when the same payload keeps throwing.
- **DX:** `npm run verify` now runs the same gates as CI (production audit, generated-type diff,
  lint, formatting, typecheck, both coverage floors, production smoke and integration). All inline
  environment variables use `cross-env`, so the scripts also work on Windows, and the webview
  coverage floor is enforced locally by default instead of only in CI.
- **CI:** every job now has an explicit timeout, and the nightly live-contract job writes a run
  summary and opens/comments on a `contract-drift` issue on failure. Being advisory no longer means
  being invisible.
- **CI:** added a smoke test against the minified, source-map-free production bundle. The full UI
  suite still runs on the development bundle (so coverage can be mapped to TypeScript), but the
  artefact that ships is now exercised before packaging.
- **Robustness:** _Delete all sessions_ is now bounded (100 pages / 10 000 ids), abortable and
  guarded by the folder generation. A broken or malicious cursor sequence can no longer keep the
  extension host busy forever, and switching folders/trust during the walk stops it before it
  deletes sessions from the old folder. Unit tests cover both the bound and the stale generation.
- **Security:** userinfo embedded in `opencode.endpoint` (`https://user:token@host`) is stripped
  before the endpoint is used as a SecretStorage key, written to the Output channel or shown in an
  error banner. The password becomes a fallback credential, and redaction also masks URL userinfo as
  a second line of defence.
- **Fix:** selecting a model or agent now commits the choice to the webview and persisted settings
  only after the server accepted the switch. A rejected switch restores the previous selection and
  reports the error. Loading a session also persists the model/agent it actually uses, so global
  settings no longer diverge silently from the open conversation.
- **CI:** the deterministic contract gate now checks every endpoint and HTTP method the client
  actually calls. `OpenCodeClient` builds requests from a shared `ENDPOINTS` registry, so a new or
  changed call cannot silently fall outside the 2.2.7 OpenAPI snapshot.
- **Fix:** a locally posted idle (Stop, rejecting a permission, dismissing a question) now also
  finishes the partial assistant message and its turn in the webview, instead of only unlocking the
  composer. Without a server terminal event those cards kept shimmering with a disabled copy button.
  A reconciliation is scheduled to replace the local snapshot with the server history.
- **Fix:** switching sessions (or starting a new one) now closes a turn that was still running on
  the previous session. Terminal events of the old session cannot arrive for the new id, so the
  status bar used to keep spinning; `ensureSession()` invalidates the token and publishes `idle`.
  `reset()` now always notifies subscribers, and the two early returns in `send()` close a turn that
  never reached the server.
- **Security:** config documents reported by the server are now treated as untrusted input. Only
  `opencode.json`/`opencode.jsonc` files inside the workspace (after resolving symlinks) may be
  opened; a path outside the workspace is ignored and creation is limited to the in-workspace
  fallback, so a remote or compromised server cannot make the extension open or create arbitrary
  files. Unit tests cover absolute paths, traversal and unrelated file names.
- **Fix:** subagent cards are now linked to their child session by tool call id. The host sends an
  explicit `linkSubagent` message as soon as `metadata.sessionID` appears on a tool event, and the
  webview remembers the id even if the card is created later — so two parallel children with the same
  description no longer cross-link and a card is not left without an _Open subagent conversation_
  action. The title match remains a fallback for snapshots without a tool id.
- **Contributing:** added `CONTRIBUTING.md` (setup, test matrix, definition of done), issue/PR
  templates and a documentation index; fixed the drifted password-size and a11y status notes.
  Prettier, `.editorconfig` and `.gitattributes` now define formatting and LF endings, with
  `format:check` in both `npm test` and CI.
- **Architecture:** turn state has a single owner (`ExecutionStateService`). Generation tokens, the
  optimistic `running` state, terminal events, locally-posted idles and the resync grace period now
  live in one class instead of three fields in the controller; the status bar and every deferred
  reconciler read that one source of truth. The controller's state machine and the webview's
  event-derived `busy` flag remain separate by design — the latter renders history/steps — but the
  host-side divergence that caused stuck spinners and re-locked composers is gone.
- **CI/DX:** `npm test` now runs lint and typecheck first, matching the CI gate; `npm run verify`
  runs the whole local gate. The Playwright suite can collect Chromium V8 coverage for the webview
  (`npm run test:coverage:ui`), mapped back to `src/webview` through the esbuild source map with an
  enforced floor, so the browser half is no longer a blind spot in the coverage report.
- **Security:** workspace containment for `openFile`, attachment chips and diff rendering now
  resolves symlinks before deciding: a link inside the folder that points outside can no longer open
  (or send to the model) a file the user never allowed. Both lexical and real-path checks must pass.
- **Robustness:** HTTP bodies, SSE buffers and raw server stdout are now size-bounded, so a broken
  server or proxy cannot exhaust the extension host's memory. Session summaries and cross-session
  search use a bounded request pool with cancellation, and "Load more" has its own generation: an
  event-burst refresh no longer invalidates a page the user just requested or discards the pages
  already loaded.
- **Security:** the managed server's password is now redacted in every encoding that can appear in
  child-process output (raw, Basic Base64/Base64URL, URL-encoded, hex, `OPENCODE_PASSWORD=…` and any
  `Authorization: Basic/Bearer` value). Raw stderr is no longer sent to the webview as an error
  detail: it stays in a length-capped, redacted diagnostic field written only to the Output channel.
- **Hardening:** every message crossing the webview ↔ host boundary is now validated at runtime
  (`src/shared/protocolGuards.ts`) before the host dispatches privileged actions or the webview
  touches its reducer. Unknown types, malformed payloads, unbounded input and action ids outside the
  protocol whitelist are dropped instead of crashing or escalating. The cross-session reveal is now
  a one-shot command that compares `data-message-id` attributes rather than interpolating the id into
  a CSS selector, so a crafted id cannot throw or pull the view back on every streamed token.
- **Fix:** a prompt refused before it reached the server (lost connection or failed request) no longer
  leaves the status bar spinner running forever. The turn's execution generation is captured when
  `send()` publishes the optimistic `running` state, and the refusal path closes it with `failed`
  only if that generation is still current. Unit and integration tests cover both the terminal
  transition and the stale-generation guard.

## Older releases

Releases before 0.3.20 are documented in [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).
At tag time each release's notes were generated from this file, so no history was lost when the
older sections were retired. The release workflow still needs the `## X.Y.Z — date` section of the
version being published; see [docs/RELEASING.md](docs/RELEASING.md).
