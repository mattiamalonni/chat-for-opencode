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
- **Windows and Linux.** Everything ran on macOS (arm64). Windows-specific code paths
  (`shell: true` spawn for `.cmd` shims, `taskkill /T` for shutdown, AltGr handling) are written
  but untested on Windows. The `ManagedServer` unit tests are skipped on Windows.
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
  only the tail and merge it via `sessionDelta`, and conversations over 40 messages are windowed
  when rendering. Not profiled with very large sessions.
- **External server mode with a real remote server** — tested only against the mock server (unit).

## Behaviour limits

- **Subagent conversations are read-only in the modal.** It renders the child's steps, thoughts,
  tools and report, but there is no composer and no approval panel: you cannot send a new prompt to
  the child, stop it, or answer a permission/question it raises from there. `send`/`abort` are
  addressed to the currently open session, so steering a child would require a protocol change;
  use the client that spawned it (or steer the parent) instead. The inline card stays the place to
  follow live progress.

- **External live updates are polled, not pushed.** A turn started in the TUI (or any other client
  that only shares the on-disk session storage) shows up in the open chat within ~2 seconds, while
  the chat is visible; when it is hidden, opening it re-syncs immediately. Only the **currently open
  session** is followed, and a session opened by another client is not auto-selected. A permission
  request or question raised by an external turn cannot be answered from this chat — answer it in the
  client that started the turn.

- **VS Code 1.99–1.103** cannot contribute to the Secondary Side Bar: the chat opens in the Explorer
  there (move it with *OpenCode: Move Chat View…*). VS Code remembers a view moved by the user, so
  users upgrading from such a setup keep their custom location.

- **Orphaned servers if VS Code crashes.** Managed servers are stopped on `deactivate` and a PID
  record (no password) is written on start, keyed by folder **and** owning extension-host PID, so
  two windows on the same folder keep separate records. On the next activation, records whose owner
  is gone are reaped only if the HTTP probe matches the recorded PID *and* the OS confirms that PID
  listens on the recorded port (`lsof` on macOS/Linux, `netstat` on Windows). If that tool is
  unavailable, the reap is skipped on purpose: leaking a server is safer than killing a process
  whose PID was reused. A server that dies before the record is written is still not covered.
- **OpenCode's base policy** allows every action without asking (observed with 2.2.7). Sessions
  created by the extension start with `edit`, `shell` and `external_directory` set to `ask` (the
  `opencode.sessionPermissions` default). Sessions created elsewhere, or after setting that option
  to `[]`, still follow OpenCode's permissive defaults. **Always allow** saves a project-scoped
  approval; use OpenCode's `permissions` config for stricter, global rules.
- **Auto-approval grants each request once.** With `opencode.autoApprovePermissions` enabled (or the
  composer's **Auto-approve** toggle for a single chat) the approval panel is skipped and every
  request is granted once on arrival; saved rules are untouched, so turning it off restores prompting
  immediately. A per-chat choice overrides the setting and is remembered across reloads.
- **Session rules override `opencode.json` rules** (verified with 2.2.7: a config rule
  `shell echo * allow` was still prompted with the default `shell * ask` session rule). Users with
  an allowlist in their OpenCode config must copy it into `opencode.sessionPermissions` or set that
  option to `[]`.
- **Themed file icons are best-effort.** If `workbench.iconTheme` is disabled or the theme cannot be
  read/parsed, chips keep the extension's built-in fallback icons. The language id is inferred from
  file names/extensions in `contributes.languages` (plus `files.associations`); a language selected
  by its first line only, or an unusual theme structure, can resolve to the theme's default icon.
- **File references open only inside the workspace.** Model output is untrusted: `data-file`
  attributes from raw HTML are stripped before prose is linkified, and the host refuses to open a
  reference that resolves outside the folder (including `../` escapes and absolute paths).
  Permission resources for files genuinely outside the workspace therefore cannot be opened by
  clicking them; open those from the explorer instead.

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
  until the first reply and after a compaction, it is computed against the *selected* model (the
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
