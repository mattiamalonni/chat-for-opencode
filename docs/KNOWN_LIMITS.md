# Known limits

Honest list of what is **not** verified or not supported. "Verified" elsewhere means an automated
test or a manual probe actually ran.

## Not verified by me

- **Clicking the real sidebar with a real server.** Covered in pieces: `npm run test:integration:real`
  runs the extension inside real VS Code against a real `opencode serve` (prompt streaming, permission
  approval, applied diff in the native diff editor, session resume after a server restart) but drives
  the controller through its message API instead of clicking the webview; the webview itself is
  tested in Playwright with recorded real events. A full VS Code quit/relaunch was simulated by a
  server restart + persisted `workspaceState`, not by actually relaunching VS Code. Manual steps in
  [MANUAL_TEST.md](MANUAL_TEST.md).
- **Windows and Linux.** Everything ran on macOS (arm64). Windows-specific code paths
  (`shell: true` spawn for `.cmd` shims, `taskkill /T` for shutdown, AltGr handling) are written
  but untested on Windows. The `ManagedServer` unit tests are skipped on Windows.
- **Real IME / Caps Lock on Windows.** IME behaviour is tested with synthetic composition events
  (`isComposing`, `keyCode 229`, `compositionend` before `Enter`) in Chromium, not with a real
  Japanese/Chinese IME, and the Windows Caps Lock IME toggle was not reproduced.
- **Key isolation inside real VS Code.** Based on reading the VS Code webview preload source
  (`window` bubble-phase `keydown` forwarding) and tested in Playwright with an equivalent listener;
  not tested by pressing Ctrl+J in a real VS Code webview.
- **Screen readers.** ARIA roles/labels and live regions are present; no test with NVDA/VoiceOver.
- **Long sessions / performance.** History pagination is capped at 2000 messages; markdown is
  re-rendered per streaming frame (cached, batched with `requestAnimationFrame`). Not profiled with
  very large sessions.
- **External server mode with a real remote server** — tested only against the mock server (unit).

## Behaviour limits

- **Orphaned servers if VS Code crashes.** Managed servers are stopped on `deactivate`; if the
  extension host is killed, `opencode serve` may survive (it has no parent-watch flag).
- **OpenCode's default permissions** allow edits and shell commands in a project without asking
  (observed with 2.2.7). The extension shows every request the server makes, but it cannot make
  the server ask. Use `opencode.sessionPermissions` or OpenCode's `permissions` config.
- **Todo list** requires OpenCode's experimental flag `experimental.todo` (tool `todowrite`);
  without it there is no todo data to show.
- **Session diff** (`GET /session/{id}/diff`) is empty outside git repositories; per-tool diffs from
  tool metadata still work.
- **Diff reconstruction** applies the server's patch to the current file. If the file changed again
  afterwards, the patch may not apply; the extension then shows the hunk-only before/after.
- **Auto context** attaches the whole active file. For very large files this costs tokens; remove
  the chip or disable `opencode.autoContext`.
- **Forms** support the field types seen in 2.2.7's schema (string with/without options, number,
  integer, boolean, multiselect, external). `when` conditions on fields are ignored.
- **Phase 5 (`@opencode` chat participant) skipped**: the official docs mark the Chat Participant API as
  deprecated and "not supported in the Copilot harness"
  (https://code.visualstudio.com/api/extension-guides/ai/chat, checked 2026-11-16), and the native
  Chat view depends on the Copilot Chat extension.
- The e2e test uses a free OpenCode model (`hy4-flash-free`); LLM answers can vary, so the
  assertions are loose (e.g. response contains "pong").
