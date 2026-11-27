# Changelog

Legend: **`User — …`** entries change something you can see or use. **`Internal — …`** entries are
build, CI or architecture work, condensed to one line; the reasoning lives in
[DECISIONS.md](docs/DECISIONS.md) and [SPEC.md](SPEC.md).

## 0.5.2 — 2026-11-27

- **User — Prompt variables filled when you send:** a library prompt goes into the composer as written,
  with `$selection`, `$file`, `$diff` and `$problems` marked, and they are filled from the editor and
  working tree at the moment you press Enter — no stale snapshot, no huge diff in the input box. A
  `$diff` typed by hand is sent as written.
- **User — The chat remembers where you were:** after a window reload, or when a hidden chat view is
  shown again, it returns to the message you were reading instead of jumping to the end.
- **User — Conditional questions:** questions whose `when` rules depend on an earlier answer appear
  only when that answer calls for them, and are left out of the reply otherwise.
- **User — Background jobs after a reconnect:** jobs that started or finished while the chat was
  disconnected are picked up from the server's job list on connect and after every reconnect.
- **Internal — Known limits refreshed:** entries made obsolete by OpenCode 2.4.1 and VS Code 1.134
  were removed or rewritten.
- **User — Long sessions open at the end:** a session with more than 2000 messages now shows its
  newest messages instead of its oldest, and the live poll no longer reloads the whole chat every two
  seconds; search and session-list badges also read the newest messages.
- **User — Apply to file saves and no longer blocks the chat:** the accepted change is saved, so the
  agent sees it on disk, a refused edit is reported instead of "Change applied", and sending, stopping
  or answering a permission works while the review is open.
- **User — Smaller fixes:** `file.ts:0` opens the file instead of failing; a failed auto-approval shows
  the request as waiting and notifies like a manual one; an unreachable server no longer flaps between
  connected and reconnecting; remote images in a reply appear as links instead of broken icons.
- **Internal — OpenAPI snapshot 2.4.1:** the contract snapshot now matches the bundled SDK; the unused
  2.2.7 and 2.3.0 snapshots were removed.

## 0.5.1 — 2026-11-27

- **User — Tidier chat UI:** one agent picker instead of two "Build" menus when custom agents exist; a
  permission card lists each file once, next to its diff; the 1/2/3 shortcut hint shows only while the
  card has focus (when the keys work); rollback/regenerate on your prompts appear on hover or focus;
  the composer hint fits one line; the setup screen no longer repeats the error three times and only
  mentions Retry when the banner offers it; "1 step" instead of "1 steps".
- **User — Friendlier first screen and clearer state:** the empty chat shows the OpenCode mark and
  starters with icons; Auto-approve, when on, keeps its label and the theme's warning colour even in a
  narrow side bar; the turn footer keeps the cost visible by dropping the start time in typical side
  bars; the export button uses a download icon.
- **Internal — README demo:** an animated hero shows a real turn (question, edit approval, applied fix);
  `npm run demo:record` re-records it from the chat webview, so it stays in sync with the UI. The
  welcome tile gets a border in high-contrast themes.
- **User — No sideways scrolling in a narrow side bar:** hidden tooltips no longer widen the view, and
  tooltips pick their side again after the bar is resized.

## 0.5.0 — 2026-11-27

- **User — Free OpenCode models work again:** the embedded host now reports its OpenCode version to
  providers. Without it the OpenCode gateway treated the extension as an anonymous client and answered
  "Free usage limit reached" for free models such as `hy4-flash-free`, even with a signed-in account.
- **User — Native binaries on every platform:** the extension now ships one package per platform
  (Linux, Alpine, macOS and Windows on x64 and arm64), each with its own native modules. Previously the single
  package carried only the binaries of the machine that built it, and never the terminal (pty) one.
- **User — Calmer reconnects:** with an unreachable external server the event stream now backs off up
  to 10 s instead of retrying every half second.
- **User — Safer restricted mode:** prompts using `$diff` no longer run git before the workspace is
  trusted, and `opencode.autoApprovePermissions` / `opencode.sessionPermissions` are restricted settings.
- **User — Alpine support:** `alpine-x64` and `alpine-arm64` packages, for example for dev containers.
  OpenCode now loads the musl variant of its file watcher there instead of the glibc one.
- **User — Cancelled requests stop:** closing the Connect panel, switching folders or reconnecting now
  cancels the requests still in flight, and links, files and diffs open at once even while a
  connection or a session load is running.
- **User — Faster startup:** the ~20 MB OpenCode SDK is a separate bundle loaded on the first
  connection, so VS Code no longer parses it at startup in windows that never open the chat.
- **User — Shortcut no longer hides Replace:** _Search All Session Conversations_ moved to
  `Cmd/Ctrl+Alt+Shift+F`; `Cmd+Alt+F` (Replace on macOS) and list find work again.
- **User — Permission settings are user-level:** `opencode.autoApprovePermissions` and
  `opencode.sessionPermissions` are read from User or Remote settings only, so a repository cannot
  loosen them. The per-workspace Auto-approve toggle is unchanged.
- **User — Sign-in commands on Windows:** provider commands are quoted for the shell the terminal
  really runs (PowerShell by default), so they start there and cannot expand `$(…)`.
- **Internal — Lifecycle and packaging:** the embedded host is closed when a stop races its startup or
  its first request fails; webview HTML comes from one helper; `npm run verify:vsix` gates every package.

## 0.4.4 — 2026-11-26

- **User — Pending responses settle on idle:** a server `session.status: idle` now closes the streaming
  card and its turn even when no `session.execution.*` terminal event follows (for example after a
  dropped SSE event). The three-dot indicator no longer pulses forever and the copy button is enabled.

## 0.4.3 — 2026-11-26

- **User — Honest transient states:** compactions now show _Compacting conversation…_ while running
  and _Compaction failed_ with the error instead of _Compacted_; shells started by the user show a
  _User shell_ card until they exit. Changing an inbox prompt from queue to steer removes it from the
  queued panel immediately, and a background result keeps its full output behind _Details_.
- **User — All background work is visible:** `experimental.job.updated` now feeds a live job registry, so
  subagent, codemode, image and video jobs get the same waiting card, session badge and composer hint
  as shell commands. Plain synthetic messages (goal/watch wake-ups, plan reminders, injected
  instructions) appear as compact notices with a _Details_ expander instead of raw XML, both live and
  after a resync.
- **User — Attention while the chat is hidden:** pending permissions/questions (including those of
  the open session and of subagents), interrupted turns and finished background commands now raise a
  VS Code notification with an _Open chat_ action. Interruptions follow `notifyOnFailure` like other
  failures instead of being silenced by `notifyOnComplete`.
- **User — Visible background jobs:** a session whose last turn ended while a shell command was moved
  to the background is now labelled _Waiting for background command_ in the session list, in the
  composer and with a spinner card in the conversation, instead of looking finished. When the job
  completes, the `<background-result>` notification is rendered as a compact card with the command
  and its last output line instead of raw XML.
- **Internal — Background result parser:** `src/shared/backgroundResult.ts` decodes the shell job
  wrapper (including unescaped quotes in the `command` attribute); `selectPendingShells` and
  `sessionWaitingShell` settle a job by matching its shell id against the result notice. The session
  picker refreshes when a shell goes to the background and when its result arrives.

## 0.4.2 — 2026-11-25

- **User — File steps open the diff:** clicking the file name in an `edit`/`write` step now opens the same native per-file diff as its `+N / -N` button, instead of the plain file. Steps without a patch (e.g. `read`) still open the file normally.
- **User — One account-focused status bar item:** the two previous items (turn state and session usage)
  are replaced by a single `$(account) OpenCode` item with a fixed icon and label. Hovering it opens a
  compact, Copilot-style panel that lists **only the connected accounts**, each on a themed rounded row
  with the active one highlighted; no auth type, integration id or session numbers. Clicking the item
  pins that same hover open, so it stays until Escape. The old click actions (stop turn, account picker,
  focus chat) and the `opencode.showUsageInStatusBar` setting are gone; `_OpenCode: Account_` remains in
  the palette as a Quick Pick.
- **Internal — Status bar presenters:** `src/status/account.ts` and `src/status/usage.ts` are replaced by
  `src/status/bar.ts` and `src/status/tooltip.ts`; the unused `src/chat/usageStatus.ts` and its tests are
  removed. A CDP/e2e test drives the real status bar hover and checks it stays pinned after the mouse
  moves away.

## Older releases

Releases before 0.4.2 are documented in [GitHub Releases](https://github.com/mattiamalonni/chat-for-opencode/releases).
At tag time each release's notes were generated from this file, so no history was lost when the
older sections were retired. The release workflow still needs the `## X.Y.Z — date` section of the
version being published; see [docs/RELEASING.md](docs/RELEASING.md).
