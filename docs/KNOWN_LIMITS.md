# Known limits

Honest list of what is **not** verified or not supported. "Verified" elsewhere means an automated
test or a manual probe actually ran.

## Not verified by me

- **Clicking the real sidebar with a real server.** `npm run test:integration:e2e` attaches to the
  real VS Code webview over CDP against the **mock** server (typing, streaming, permission approval).
  `npm run test:integration:real` runs the extension inside real VS Code against a real
  `opencode serve` but drives the controller through its message API. `npm run test:integration:real:e2e`
  combines the two: real webview clicks plus a real server, waiting for the real streamed reply.
  A full VS Code quit/relaunch is still manual; see [MANUAL_TEST.md](MANUAL_TEST.md).
- **Windows and Linux.** Development and manual checks ran on macOS (arm64); CI runs lint, unit,
  integration and packaging on `ubuntu-latest`, `macos-latest` and `windows-latest`, so the
  Windows-specific paths (`.cmd` shims under `shell: true`, `taskkill /T`, AltGr handling) now have
  automated coverage. The `ManagedServer` unit tests are no longer skipped on Windows. What is
  still unverified is real human interaction on those OSes (see IME below) and the author's own
  manual walkthrough.
- **Real IME / Caps Lock on Windows.** IME behaviour is tested with synthetic composition events
  (`isComposing`, `keyCode 229`, `compositionend` before `Enter`) in Chromium, not with a real
  Japanese/Chinese IME, and the Windows Caps Lock IME toggle was not reproduced.
- **Key isolation inside real VS Code.** Based on reading the VS Code webview preload source
  (`window` bubble-phase `keydown` forwarding) and tested in Playwright with an equivalent listener.
  Select All (`Cmd+A`) was also verified end to end in the real VS Code webview over CDP (the chord
  reaches the preload and the whole prompt is selected). Other chords such as Ctrl+J were not tested
  by pressing real keys in a real VS Code webview.
- **Screen readers.** ARIA roles/labels and live regions are present, and the UI suite now checks
  the accessibility tree of the composer and permission cards; no test with NVDA/VoiceOver.
- **Long sessions / performance.** History pagination is capped at 2000 messages; markdown is
  re-rendered per streaming frame (cached, batched with `requestAnimationFrame`). Reconnects fetch
  only the tail and merge it via `sessionDelta`. Every top-level conversation card (messages, tools,
  steps and turn summaries) is laid out: `content-visibility: auto` was removed because its intrinsic
  height estimate left a newly opened long conversation far short of the real bottom and made the view
  feel unscrollable. This is **not DOM windowing** — every message is still built as a node and
  `conversationItems()` is recomputed on each update, so the cost grows with the length of the history. The remote caches (auto-approved ids, virtual diffs, subagents and
  their metadata, touched files) and the webview's live-event queues are bounded to prevent unbounded
  growth, but a single conversation with very large messages or patches is still not profiled.
- **External server mode with a real remote server** — tested only against the mock server (unit).
- **Real OpenCode contract drift.** CI runs a dedicated `contract` job nightly and on manual dispatch
  against a pinned `opencode@2.2.7`, with `continue-on-error`: it reports a regression but does not
  block a merge, because it needs a real binary and provider credentials. A failure now writes a
  run summary and opens (or comments on) a `contract-drift` issue, so it cannot pass unnoticed; all
  CI jobs also have explicit timeouts. The deterministic half is
  now a blocking gate on every push/PR: a named CI step checks that all 989 recorded 2.2.7 SSE events
  still normalize and that the OpenAPI snapshot still lists every endpoint the client calls.
- **Untrusting a workspace mid-session.** The 1.99 API exposes only `onDidGrantWorkspaceTrust`;
  removing trust takes effect in VS Code after a window reload. The extension re-checks `isTrusted`
  on every connect/reconnect, so no process is started or secret read in the meantime.

## Architectural debt

- **`ChatController` is still the orchestrator for many concerns.** Connection supervision, session
  listing, subagents, attachments, diffs, permissions and turn state already live in dedicated
  services (`ConnectionSupervisor`, `SessionListService`, `SubagentTracker`, `AttachmentService`,
  `DiffService`, `PermissionService`, `ExecutionStateService`). The remaining large blocks are
  `onEvent()` (event routing) and `handle()` (webview command dispatch). Splitting those into an
  event router and a command handler is the next refactor: it needs a dependency-injection boundary
  wide enough that unit tests can exercise them without a VS Code host. Turn state itself is no
  longer duplicated — see `src/chat/executionState.ts`.
- **The webview's `busy` flag is still derived from server events**, not from the host's execution
  status. This is deliberate: it renders per-step history and queued turns. The two state machines
  can still disagree briefly during a resync, but the host-side one (status bar, composer unlocking)
  has a single owner and generation guard.

## Behaviour limits

- **Queued prompts cannot be edited in place.** OpenCode's inbox `PATCH` only accepts `delivery`
  (`queue` or `steer`): the panel can promote an item to _send now_, but _Put back in composer to
  edit_ cancels the item and restores its text in the composer instead of patching it. The API also
  exposes no reordering, and non-`user` items (subagent reports, compaction, moves) have no edit
  action.
- **Subagent conversations are read-only in the modal.** It renders the child's steps, thoughts,
  tools and report, but there is no composer: you cannot send a new prompt to the child, stop it or
  steer it from there (`send`/`abort` are addressed to the currently open session, so that would need
  a protocol change). Pending permissions and questions **can** be answered from the approval panel
  docked in the modal, or from the main chat's overlay: the reply carries the child's session id.
  The inline card stays the place to follow live progress.

- **External live updates are polled, not pushed.** A turn started in the TUI (or any other client
  that only shares the on-disk session storage) shows up in the open chat within ~2 seconds, while
  the chat is visible; when it is hidden, opening it re-syncs immediately. Only the **currently open
  session** is followed, and a session opened by another client is not auto-selected. A permission
  request or question raised by an external turn cannot be answered from this chat — answer it in the
  client that started the turn.

- **VS Code 1.99–1.103** cannot contribute to the Secondary Side Bar: the chat opens in the Explorer
  there (move it with _OpenCode: Move Chat View…_). VS Code remembers a view moved by the user, so
  users upgrading from such a setup keep their custom location.
- **Open Chat in Editor** is a second view of the same session, not an independent conversation:
  switching sessions in either view switches both. The tab is restored after a window reload via a
  webview panel serializer, but its scroll position and any unsubmitted text are not.

- **Orphaned servers if VS Code crashes.** Managed servers are stopped on `deactivate` and a PID
  record (no password) is written on start, keyed by folder **and** owning extension-host PID, so
  two windows on the same folder keep separate records. On the next activation, records whose owner
  is gone are reaped only if the HTTP probe matches the recorded PID _and_ the OS confirms that PID
  listens on the recorded port (`lsof` on macOS/Linux, `netstat` on Windows). If that tool is
  unavailable, the reap is skipped on purpose: leaking a server is safer than killing a process
  whose PID was reused. A server that dies before the record is written is still not covered.
  A record is cleared only if it still names the child that is exiting, so the late exit of a failed
  start cannot delete the record of the replacement the user reconnected to.
- **OpenCode's base policy** allows every action without asking (observed with 2.2.7). Sessions
  created by the extension start with `edit`, `shell` and `external_directory` set to `ask` (the
  `opencode.sessionPermissions` default). Sessions created elsewhere, or after setting that option
  to `[]`, still follow OpenCode's permissive defaults. **Always allow** saves a project-scoped
  approval; use OpenCode's `permissions` config for stricter, global rules.
- **Auto-approval grants each request once.** With `opencode.autoApprovePermissions` enabled (or the
  composer's **Auto-approve** toggle for a single chat) the approval panel is skipped and every
  request is granted once on arrival; saved rules are untouched, so turning it off restores prompting
  immediately. A per-chat choice overrides the setting and is remembered across reloads. Subagents
  inherit the chat's choice, so their requests are granted the same way.
- **Session rules override `opencode.json` rules** (verified with 2.2.7: a config rule
  `shell echo * allow` was still prompted with the default `shell * ask` session rule). Users with
  an allowlist in their OpenCode config must copy it into `opencode.sessionPermissions` or set that
  option to `[]`.
- **Themed file icons are best-effort.** If `workbench.iconTheme` is disabled or the theme cannot be
  read/parsed, chips keep the extension's built-in fallback icons. The language id is inferred from
  file names/extensions in `contributes.languages` (plus `files.associations`); a language selected
  by its first line only, or an unusual theme structure, can resolve to the theme's default icon.
  Themes that reference remote `https:` assets are not supported: the extension never fetches them
  and the webview CSP does not allow remote images or fonts, so those icons stay empty.
- **File references open only inside the workspace.** Model output is untrusted: `data-file`
  attributes from raw HTML are stripped before prose is linkified, and the host refuses to open a
  reference that resolves outside the folder (including `../` escapes and absolute paths). The same
  containment rule applies to native diffs opened from tool metadata. Permission resources for files
  genuinely outside the workspace therefore cannot be opened by clicking them; open those from the
  explorer instead.

- **Inline attachment copies** (clipboard images, files pasted or dropped without a path) are written
  to the OS temp folder so their chips can be opened in the editor. The host keeps at most 50 of them,
  evicting the oldest when a new one arrives; the rest are removed on extension deactivation. A copy
  evicted this way is no longer openable from an old chip, though its bytes are still in that prompt.
- **Other OpenCode versions** are not supported: only 2.2.7's contract (types and SSE fixtures) was
  verified. Other 2.2.x patch releases are assumed compatible without a warning; the chat warns for
  another minor (untested) or major (unsupported) version. A runtime smoke test checks the raw
  response shape of the catalog and history endpoints and names the affected features in a banner.
  `src/shared/adapter.ts` normalises missing/renamed fields so the UI degrades gracefully, and the
  raw wire types are generated from the snapshot with `npm run gen:types`, but neither can adapt to
  changed endpoints or event semantics. Supporting a new version means extending the adapter.
- **Context meter is an estimate** from the last step's token usage (see API_NOTES). It is unknown
  until the first reply and after a compaction, it is computed against the _selected_ model (the
  one the next message will use), and whether reasoning tokens stay in context depends on the
  provider.
- **Todo list** requires OpenCode's experimental flag `experimental.todo` (tool `todowrite`);
  without it there is no todo data to show.
- **Session diff** (`GET /session/{id}/diff`) is empty outside git repositories. The webview now
  fills the changed-files panel from completed tools' patch metadata as a fallback, but the panel
  can miss a change whose tool did not record `metadata.files`.
- **Diff reconstruction** applies the server's patch to the current file for a single-file diff. If
  the file changed again afterwards and the patch no longer applies, the fallback shows the hunk-only
  before/after. The combined turn/session diff always uses that hunk-only form, so it shows only the
  recorded changes and never the full file content.
- **Auto context** shows the whole active file as a chip, but the file is attached only when you add
  it to the message. Selections are attached automatically. For very large files this costs tokens
  once added; disable `opencode.autoContext` to hide both chips.
- **Forms** support the field types seen in 2.2.7's schema (string with/without options, number,
  integer, boolean, multiselect, external). `when` conditions on fields are ignored.
- **Phase 5 (`@opencode` chat participant) skipped**: the official docs mark the Chat Participant API as
  deprecated and "not supported in the Copilot harness"
  (https://code.visualstudio.com/api/extension-guides/ai/chat, checked 2026-11-16), and the native
  Chat view depends on the Copilot Chat extension.
- The e2e test uses a free OpenCode model (`hy4-flash-free`); LLM answers can vary, so the
  assertions are loose (e.g. response contains "pong").
