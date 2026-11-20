# Manual test (real VS Code + real `opencode serve`)

Prerequisites: OpenCode v2 on `PATH` (`opencode --version`), a provider configured
(`opencode models` lists models), the `.vsix` built with `npx @vscode/vsce package`.

## What is already automated

Run these first; they cover most of the contract with the **mock** server:

- `npm test` — unit (reducer, adapter, client, SSE, permissions, patches), Playwright UI and
  VS Code integration.
- `npm run test:integration:e2e` — the **real webview inside VS Code** driven over CDP: typing a
  prompt, streaming a reply and clicking *Allow once* on a permission card in the panel above the
  composer.
- `npm run test:integration:real` — the extension inside VS Code against a **real** server
  (streaming, permission approval, applied diff, resume after a server restart), but it drives the
  controller through its message API rather than clicking the webview.
- `npm run test:integration:real:e2e` — **real clicks plus a real server**: types a prompt in the
  actual webview and waits for the real streamed reply.
- UI tests also assert the accessibility tree of the composer and permission cards; this is not a
  substitute for a real screen reader.

This checklist covers what automation still cannot: a full VS Code quit/relaunch, real IME,
screen readers and multi-window process management.

## Checklist

1. **Install**: `code --install-extension chat-for-opencode-<version>.vsix`, reload the window.
2. **Prepare a project**:
   ```sh
   mkdir /tmp/oc-manual && cd /tmp/oc-manual && git init && echo a > a.txt && git add . && git commit -m init
   code /tmp/oc-manual
   ```
   In *Settings (Workspace)* set
   `"opencode.sessionPermissions": [{"action":"edit","resource":"*","effect":"ask"}]`
   so edits require approval.
3. **Open the sidebar**: click the OpenCode icon. Expect "Starting OpenCode…" then the welcome text.
   *OpenCode: Show Logs* shows `server listening on http://127.0.0.1:<port>` and the password as `***`.
4. **Streaming**: send `Explain what a git commit is in 3 bullet points`. Expect text appearing
   progressively, a collapsible *Thoughts* block if the model reasons, the stop button while running.
5. **Stop**: send `Write a 2000 word essay about compilers` and press `Esc` (or the stop button).
   Expect "Response interrupted." and the composer to become usable again.
6. **Permission + diff**: send `Change a.txt so it contains b instead of a`. An `edit` tool card shows
   *Permission required* with `a.txt`. Click the file row → native diff `a` → `b` (proposed).
   Click **Allow once**. The file changes; *1 Changed file* appears above the input with `+1 / -1`
   totals. Clicking the totals opens a single read-only diff with all the session's changes; clicking
   the file opens its applied diff. The turn summary bar also shows `+1 / -1` — click it to open that
   turn's changes in one diff.
7. **Reject**: ask for another edit and press **Reject**: the tool card turns red, file unchanged.
8. **Auto-approve**: click **Auto-approve** in the composer, ask for another edit: no permission
   card appears and the file changes right away. Switch chats and confirm the toggle is per chat;
   disable it again and confirm the cards return.
9. **Context**: open `a.txt`, select the line. Chips `a.txt (Current file)` and `a.txt:1` appear;
   remove one with ×; send `What does the selection contain?`. The user bubble lists the attachment.
   Right-click → *Add Selection to Chat* adds a chip.
10. **@ mention and excludes**: type `@a.t`, choose `a.txt` with ↓/Enter. In a repo with
    `node_modules` or `dist`, confirm those folders are **not** offered: the picker now respects
    `search.exclude` and `files.exclude`.
11. **Skills**: ensure OpenCode has discovered a skill from a supported [skill location](https://opencode.ai/docs/skills/#discovery),
    type `/` and choose it. Expect `/skill-id` in the composer; send it with a request and confirm
    OpenCode loads the skill. Other slash commands should remain unchanged.
12. **Sessions and drafts**: click the session title → list; create a new session with `+`; switch
    back. Before switching, type a half-finished message; come back and confirm the **draft for that
    session is still there**, while the other session kept its own (empty) draft. Sending clears it.
    Quit and reopen VS Code: the draft must still be there (it is now in `workspaceState`).
12b. **Queue and steer**: start a long answer, then type another message. The hint should say that
    `Enter` queues it and `Ctrl/Cmd+Enter` sends now; press `Enter` and confirm the message is
    delivered after the current answer finishes. Repeat with `Ctrl/Cmd+Enter`: the current answer
    must be interrupted and the new one answered.
12c. **Permission shortcuts**: when a permission card appears in the panel above the composer, Tab
    to it and press `1` (Allow once) or `3` (Reject); `2` (Always allow) should only exist when the
    request offers saved rules. With several requests pending, check the counter and that
    *Previous* / *Next* move through the queue without affecting the current answer. Clicking
    *Cancel* on a question and *Reject* on a permission card must also stop the current reply (the
    **Stop** button disappears); *Allow once* / *Always allow* must let it continue. If the agent
    bundles several questions, check that they are shown one at a time and that *Next question*
    keeps earlier answers before a single submit.
12d. **Export and search**: use the header buttons to export the conversation as a `.md` file and to
    search for a word you used earlier; non-matching messages must be hidden and the result count
    shown. Add a large inline attachment and check the context meter shows a `~`-prefixed estimate.
13. **Resume after restart**: quit VS Code completely (`Cmd/Ctrl+Q`), check `ps aux | grep "opencode serve"`
    shows no process started by the extension, reopen the folder and the sidebar. The last session
    and its messages are restored.
14. **Two windows on the same folder**: open the same folder in a second VS Code window. Each window
    should start **its own** server; in global storage there should be two PID records named
    `<folderHash>-<ownerPid>.json`. Quit one window and confirm the other window's server keeps
    running and its chat stays usable (the orphan reaper must not kill a live owner's server).
15. **Errors and contract banner**: set `opencode.executablePath` to `/nope` → banner *OpenCode is not
    installed…* with *Install OpenCode / Open settings / Show logs*. Reset the setting → reconnects.
    Kill the server process (`kill <pid>` from the logs) → banner "Reconnecting…" then back to normal.
    If you can point `opencode.endpoint` at a **different** OpenCode version, confirm the contract
    banner names the features whose response shape changed (the adapter normalises fields, but the
    raw-shape warning must still appear) and that dismissing it persists for that signature.
16. **Keyboard**: in the input press `Ctrl+J` / `Ctrl+R` / `Ctrl+K`: the panel must **not** toggle and the
    recent-files picker must **not** open. `Cmd/Ctrl+Shift+P` still opens the command palette;
    copy/paste work. With the chat focused, `Cmd/Ctrl+N` must start a new session (no untitled file);
    the same chord in the editor must still create a new file.
17. **IME** (if available): type Japanese with the system IME and confirm a candidate with Enter: the
    message must not be sent until a second Enter.
18. **Language**: *Configure Display Language → it*, restart: the UI strings stay in English (there is
    no Italian bundle), but the webview's `<html lang>` must now follow VS Code. In the webview
    developer tools, `document.documentElement.lang` should be `"it"` (it was hard-coded `"en"`).
19. **Incremental resync** (only if you can drop just the SSE stream, e.g. a local proxy that closes
    `GET /api/event` without restarting the server): after a reconnect, the conversation must **not**
    jump back to the top: scroll position, staged attachments and the composer draft survive, and
    only the messages produced while disconnected are appended. A server restart instead performs a
    full reload, which is expected. The merge itself is covered by the reducer unit tests and by a
    Playwright UI test that sends a `sessionDelta` and checks that staged chips are preserved.
20. **Screen reader** (if available): with VoiceOver/NVDA, focus the composer and confirm its label,
    the session picker and the permission cards announce their role and state.
