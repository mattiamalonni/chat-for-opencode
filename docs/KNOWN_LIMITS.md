# Known limits

Honest list of what is **not** verified or not supported. "Verified" elsewhere means an automated
test or a manual probe actually ran.

## Not verified by me

- **Connect panel — provider coverage.** The panel is driven by `/api/integration` and
  `/api/credential`; its protocol, form rendering, key submission and account actions are covered by
  automated tests. A full live OAuth login was manually verified with **GitHub Copilot**; other
  providers' OAuth/command/external methods follow the same API but have not been tried one by one.
  Environment-variable methods are deliberately hidden from the panel because a webview cannot set
  a variable on the host process — configure those in your OpenCode config (or on a server you run
  yourself), then refresh.
- **Clicking the real sidebar with a real server.** `npm run test:integration:e2e` attaches to the
  real VS Code webview over CDP against the **mock** server (typing, streaming, permission approval).
  `npm run test:integration:real` runs the extension inside real VS Code against a real
  embedded SDK but drives the controller through its message API. `npm run test:integration:real:e2e`
  combines the two: real webview clicks plus a real host, waiting for the real streamed reply.
  A full VS Code quit/relaunch is still manual; see [MANUAL_TEST.md](MANUAL_TEST.md).
- **Windows and Linux.** Development and manual checks ran on macOS (arm64); CI runs lint, unit,
  integration and packaging on `ubuntu-latest`, `macos-latest` and `windows-latest`, so the
  Windows-specific paths (`.cmd` shims under `shell: true`, `taskkill /T`, AltGr handling) have
  automated coverage. The `ManagedServer` unit tests cover Windows as well. What is
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
- **Screen readers.** ARIA roles/labels and live regions are present, and the UI suite checks
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
- **Real OpenCode contract drift.** The `contract` job runs only on manual CI dispatch against a
  pinned SDK, with `continue-on-error`: it reports a regression but does not block a
  release, because it needs a real binary and provider credentials. A failure writes a
  run summary and opens (or comments on) a `contract-drift` issue, so it cannot pass unnoticed; all
  CI jobs also have explicit timeouts. The deterministic half is
  a blocking gate in release CI: `test:unit` checks that all 989 recorded 2.2.7 SSE events
  normalize and that the OpenAPI snapshot lists every endpoint the client calls.
- **Untrusting a workspace mid-session.** The 1.99 API exposes only `onDidGrantWorkspaceTrust`;
  removing trust takes effect in VS Code after a window reload. The extension re-checks `isTrusted`
  on every connect/reconnect, so no process is started or secret read in the meantime.

## Architectural debt

- **`ChatController` orchestrates many concerns through dedicated services.**
  Connection supervision, session listing, subagents, attachments, diffs, permissions, turn state,
  server-event routing and webview command dispatch live in dedicated services (`ConnectionSupervisor`,
  `SessionListService`, `SubagentTracker`, `AttachmentService`, `DiffService`, `PermissionService`,
  `ExecutionStateService`, `ChatEventRouter`, `ChatCommandHandler`). The controller wires them
  together and owns the session/conversation lifecycle; it is under 1,000 lines, but the two previous
  dispatch units are independently testable through explicit hooks objects. Turn state itself
  is kept in one place — see `src/chat/executionState.ts`.
- **The webview's `busy` flag is still derived from server events**, not from the host's execution
  status. This is deliberate: it renders per-step history and queued turns. The two state machines
  can still disagree briefly during a resync, but the host-side one (status bar, composer unlocking)
  has a single owner and generation guard.

## Behaviour limits

- **Jobs are tracked from live events only.** The bundled client does not expose
  `/api/experimental/job`, so the pending-job registry is fed by `experimental.job.updated`: jobs
  started while the chat was disconnected are not known until the next update. Shell jobs are also
  recovered from the conversation history (`background: true` plus a shell id), but codemode, image
  and video jobs started before connecting stay invisible.
- **Multi-root still has one active connection.** The chat talks to one folder's server at a time;
  files and sessions from other folders are available for context, navigation and switching, but
  there is no combined stream or single session spanning folders. Sessions from another folder are
  not shown until you switch to it — the folder label on a row tells you where it lives. Adding a
  folder rebuilds the file index; very large monorepos still share the 20 000-file scan cap.
- **Prompt variables are snapshots.** `$diff` and `$problems` reflect the workspace when you pick the
  prompt, not when you finally press Enter; `$file` and `$selection` come from the editor active at
  pick time. A prompt whose id matches a skill or command wins in the `/` picker; use a distinct id for
  custom prompts.
- **Applying a code block needs a target file.** The webview guesses the one referenced just above
  the block; when the guess is missing or wrong, a QuickPick of workspace files takes over. A
  full-file block replaces the entire file, so it is only appropriate when the reply really contains
  the whole file. The target must resolve inside the connected folder; files outside it cannot be
  written. The diff preview and Accept notification are native VS Code UI, so automated tests can
  assert the preview but cannot click Accept.

- **Queued prompts cannot be edited in place.** OpenCode's inbox `PATCH` only accepts `delivery`
  (`queue` or `steer`): the panel can promote an item to _send now_, but _Put back in composer to
  edit_ cancels the item and restores its text in the composer instead of patching it. The API also
  exposes no reordering, and non-`user` items (subagent reports, compaction, moves) have no edit
  action.
- **The subagent modal's composer is deliberately minimal.** It renders the child's steps, thoughts,
  tools and report and can send, queue or stop that child, but it has no attachments, model/agent
  picker or slash-command UI: the main composer owns those. A reply goes to the child only and never
  enters the parent conversation. Pending permissions and questions **can** be answered from the
  approval panel docked in the modal, or from the main chat's overlay: the reply carries the child's
  session id. The inline card stays the place to follow live progress.

- **The amber session-list dot needs the server's live state.** Green and red come from the session
  history, but a pending permission or form is not a message: the server keeps it only in
  `GET …/permission` / `GET …/form` and in its event stream. The history has the tool call (with a
  `running` state) but neither the request id nor a reliable marker for "answered", so a tool that is
  merely executing must not be marked as waiting. The amber dot therefore cannot be reconstructed
  from history alone after a reload and is only shown for sessions that can have a pending request.
- **External live updates are polled, not pushed.** A turn started in the TUI (or any other client
  that only shares the on-disk session storage) shows up in the open chat within ~2 seconds, while
  the chat is visible; when it is hidden, opening it re-syncs immediately. Only the **currently open
  session** is followed, and a session opened by another client is not auto-selected. A permission
  or question raised by another client **on the same server** is shown in the approval panel and can
  be answered here; a client using only the on-disk storage has no event stream to forward, so its
  requests still have to be answered where the turn was started.

- **VS Code 1.99–1.103** cannot contribute to the Secondary Side Bar: the chat opens in the Explorer
  there (move it with _OpenCode: Move Chat View…_). VS Code remembers a view moved by the user, so
  users upgrading from such a setup keep their custom location.
- **Open Chat in Editor** is a second view of the same session, not an independent conversation:
  switching sessions in either view switches both. The tab is restored after a window reload via a
  webview panel serializer, but its scroll position and any unsubmitted text are not.

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
  evicted this way is not openable from an old chip, though its bytes are still in that prompt.
- **Dependency advisories.** `@opencode/core` depends on `gitlab-ai-provider`, which pins `zod` 3.x;
  npm reports a high-severity advisory for that version. The extension keeps OpenCode's dependency
  tree intact instead of overriding a transitive package, so `npm audit --audit-level=high` stays
  dirty. The release gate checks `critical` advisories and `npm run audit:high` prints the full list.
- **Version policy.** The extension ships a pinned SDK (2.4.1), so an installed release has exactly
  one OpenCode version and cannot drift at runtime. Upgrading OpenCode requires a new extension
  release; the embedded host does not read a CLI version from the machine. The contract smoke test,
  version banner and `src/shared/adapter.ts` normalisers apply to a server reached through
  `opencode.endpoint` and provide a safety net for the webview. Supporting a different SDK means
  bumping the dependency, regenerating types if needed, and re-running the full suite.
- **The Claude Agent provider does not work in the embedded host.** OpenCode's provider drives
  `@anthropic-ai/claude-agent-sdk`, whose JavaScript is bundled but whose native CLI binary is not:
  it is about 240 MB per platform, too large to ship in every VSIX. Choosing that provider fails with
  _Native CLI binary for … not found_. Other providers are unaffected. To use it, run an OpenCode
  server yourself from an installed CLI and point `opencode.endpoint` at it.
- **Platform coverage.** Native modules ship per platform (see
  [RELEASING.md](RELEASING.md#platform-packages)): Linux, Alpine, macOS and Windows on x64 and
  arm64. 32-bit ARM and VS Code for the Web have no package and cannot install the extension. On
  Alpine, node-pty has no musl binary: OpenCode's terminal features need the `gcompat` package.
  OpenCode publishes no `@number0/iroh` binary for macOS Intel, so iroh-backed features are missing
  on `darwin-x64`.
- **Status bar usage is the same estimate** as the composer's context meter (see API_NOTES). It is
  unknown until the first reply (and after a compaction), so the item stays hidden until OpenCode
  reports numbers. It mirrors the **open session** only and is cleared when that session closes;
  the running cost of other sessions is not accumulated.
- **Context meter is an estimate** from the last step's token usage (see API_NOTES). It is unknown
  until the first reply and after a compaction, it is computed against the _selected_ model (the
  one the next message will use), and whether reasoning tokens stay in context depends on the
  provider.
- **Todo list** requires OpenCode's experimental flag `experimental.todo` (tool `todowrite`);
  without it there is no todo data to show.
- **Session diff** (`GET /session/{id}/diff`) is empty outside git repositories. The webview
  fills the changed-files panel from completed tools' patch metadata as a fallback, but the panel
  can miss a change whose tool did not record `metadata.files`.
- **Diff reconstruction** applies the server's patch to the current file for a single-file diff. If
  the file changed again afterwards and the patch does not apply, the fallback shows the hunk-only
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
