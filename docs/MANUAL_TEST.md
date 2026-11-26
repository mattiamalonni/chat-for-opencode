# Manual test (real VS Code + embedded OpenCode SDK)

Prerequisites: VS Code 1.134+, a provider configured through the Connect panel, and the `.vsix`
built with `npx @vscode/vsce package`. OpenCode itself is bundled — no CLI or server is needed.

## What is already automated

Run the deterministic suites first — the [test matrix](../CONTRIBUTING.md#tests-which-suite-for-what)
is the single list of commands and what each covers. Of the opt-in suites,
`npm run test:integration:e2e` drives the **real webview inside VS Code** over CDP against the mock
server (typing, streaming, approving), `npm run test:integration:real` uses a **real server** through
the controller's message API, and `npm run test:integration:real:e2e` combines real clicks with a
real server. UI tests also assert the accessibility tree of the composer and permission cards; this
is not a substitute for a real screen reader.

This checklist covers what automation still cannot: a full VS Code quit/relaunch, real IME,
screen readers and multi-window process management.

## Checklist

1. **Install**: `code --install-extension chat-for-opencode-<version>.vsix`, reload the window.
2. **Prepare a project**:
   ```sh
   mkdir /tmp/oc-manual && cd /tmp/oc-manual && git init && echo a > a.txt && git add . && git commit -m init
   code /tmp/oc-manual
   ```
   In _Settings (Workspace)_ set
   `"opencode.sessionPermissions": [{"action":"edit","resource":"*","effect":"ask"}]`
   so edits require approval.
3. **Open the sidebar**: click the OpenCode icon. Expect "Starting OpenCode…" then the welcome text.
   _OpenCode: Show Logs_ shows `[sdk] host ready (opencode …)` and no password.
   3b. **Connect panel**: run _OpenCode: Connect Provider…_ from the palette (or the plug icon in the
   chat header). The provider grid loads and saved accounts, if any, appear in a **Connected
   accounts** card at the top, active first. The chat must stay connected — no "Starting OpenCode…"
   banner while the panel loads or after signing in. Environment-variable methods must not be
   offered.
   - Click a provider card with one sign-in method (e.g. GitHub Copilot): the form opens directly.
     A provider with two methods (e.g. OpenAI: API key + ChatGPT) shows the small method picker;
     fields with options (GitHub deployment type) are `<select>`s and the Enterprise URL appears
     only when _enterprise_ is chosen.
   - Complete a GitHub Copilot browser sign-in: the code screen **closes by itself** on success, the
     new account appears in the list and the chat model picker updates. Close the panel while an
     attempt is pending and reopen it: no stale spinner and no error notice from the cancelled poll.
   - On a saved account try _Use this account_, _Rename account_ and _Remove account_ (the last one
     asks for confirmation). Then hover the `$(account) OpenCode` status bar item: its tooltip lists
     only the connected accounts, with the active one highlighted; click to pin it open and press
     Escape to close it. _OpenCode: Account_ still opens the same list as a Quick Pick.
4. **Streaming**: send `Explain what a git commit is in 3 bullet points`. Expect text appearing
   progressively, a collapsible _Thoughts_ block if the model reasons, the stop button while running.
   When the reply finishes, the step folds close on their own while the answer stays visible; click a
   **Step N** header or **Expand all steps in this turn** to reopen its reasoning and tool calls.
   Send another prompt and confirm the new reply's folds open and close independently of the previous one.
5. **Stop**: send `Write a 2000 word essay about compilers` and press `Esc` (or the stop button).
   Expect "Response interrupted." and the composer to become usable again.
6. **Permission + diff**: send `Change a.txt so it contains b instead of a`. An `edit` tool card shows
   _Permission required_ with `a.txt`. Click the file row → native diff `a` → `b` (proposed).
   Click **Allow once**. The file changes; _1 Changed file_ appears above the input with `+1 / -1`
   totals. Clicking the totals opens a single read-only diff with all the session's changes; clicking
   the file opens its applied diff. The turn summary bar also shows `+1 / -1` — click it to open that
   turn's changes in one diff.
7. **Reject**: ask for another edit and press **Reject**: the tool card turns red, file unchanged.
8. **Auto-approve**: click **Auto-approve** in the composer, ask for another edit: no permission
   card appears and the file changes right away. Switch chats and confirm the toggle is per chat;
   disable it again and confirm the cards return.
9. **Context**: open `a.txt`, select the line. Chips `a.txt (Current file)` and `a.txt:1` appear;
   remove one with ×; send `What does the selection contain?`. The user bubble lists the attachment.
   Pick `/bugs` and confirm the selection is resolved into the prefilled prompt (never sent).
10. **@ mention and excludes**: type `@a.t`, choose `a.txt` with ↓/Enter. The file becomes a chip
    and the `@a.t` text **disappears from the composer**; the chip alone is sent with the message.
    In a repo with `node_modules` or `dist`, confirm those folders are **not** offered: the picker
    respects `search.exclude` and `files.exclude`.
11. **Skills**: ensure OpenCode has discovered a skill from a supported [skill location](https://opencode.ai/docs/skills/#discovery),
    type `/` and choose it. Expect `/skill-id` in the composer, **underlined like a link**; a typo
    such as `/nope` stays plain text. Send it with a request and confirm OpenCode loads the skill.
    Other slash commands should remain unchanged and be underlined too.
12. **Sessions and drafts**: click the session title → list; create a new session with the `+` button
    in the chat header (just before the refresh icon); switch
    back. Before switching, type a half-finished message; come back and confirm the **draft for that
    session is still there**, while the other session kept its own (empty) draft. Sending clears it.
    Quit and reopen VS Code: the draft must still be there (`workspaceState` holds it).
    12b. **Queue and steer**: start a long answer, then type another message. The hint should say that
    `Enter` queues it and `Ctrl/Cmd+Enter` sends now; press `Enter` and confirm the message shows up
    in the **Queued messages** panel but **not** in the chat conversation yet. When the current
    answer finishes, the queued prompt must leave the panel and appear in the chat before its reply.
    Repeat with `Ctrl/Cmd+Enter`: the current answer must be interrupted and the new one answered.
    12c. **Permission shortcuts**: when a permission card appears in the panel above the composer, Tab
    to it and press `1` (Allow once) or `3` (Reject); `2` (Always allow) should only exist when the
    request offers saved rules. With several requests pending, check the counter and that
    _Previous_ / _Next_ move through the queue without affecting the current answer. Clicking
    _Cancel_ on a question and _Reject_ on a permission card must also stop the current reply (the
    **Stop** button disappears); _Allow once_ / _Always allow_ must let it continue. If the agent
    bundles several questions, check that they are shown one at a time and that _Next question_
    keeps earlier answers before a single submit.
    12d. **Export and search**: use the header buttons to export the conversation as a `.md` file and to
    search for a word you used earlier; non-matching messages must be hidden and the result count
    shown. Add a large inline attachment and check the context meter shows a `~`-prefixed estimate.
    12e. **Toolbar actions**: from the view title,
    the refresh icon opens **Restart Server…** with a modal confirmation that has exactly one
    _Cancel_ button (the native one) plus _Restart_; the gear icon opens the VS Code Settings view
    filtered to this extension. Cancelling the restart must leave the chat and its server connected.
13. **Resume after restart**: quit VS Code completely (`Cmd/Ctrl+Q`), confirm no `opencode` process
    exists, reopen the folder and the sidebar. The last session and its messages are restored.
14. **Two windows on the same folder**: open the same folder in a second VS Code window. Each window
    has its own embedded SDK host inside its extension host; closing one must not affect the other.
15. **Errors and contract banner**: with `opencode.endpoint` pointed at an unreachable URL you get a
    _Reconnecting…_ banner; fixing the setting reconnects. If the endpoint runs a **different**
    OpenCode version, confirm the contract banner names the features whose response shape changed
    (the adapter normalises fields, but the
    raw-shape warning must still appear) and that dismissing it persists for that signature.
    With an `opencode.endpoint` on another host/container, attach the current file and a selection
    and send: the prompt must succeed instead of failing with _Unable to read attachment_, because
    local `file:` URIs are inlined for external servers. Point the endpoint at a server whose
    filesystem cannot see a deleted local file to check the clear _Could not read an attached file_
    notice instead of a failed send.
16. **Keyboard**: in the input press `Ctrl+J` / `Ctrl+R` / `Ctrl+K`: the panel must **not** toggle and the
    recent-files picker must **not** open. `Cmd/Ctrl+Shift+P` still opens the command palette;
    copy/paste work. With the chat focused, `Cmd/Ctrl+N` must start a new session (no untitled file);
    the same chord in the editor must still create a new file.
17. **IME** (if available): type Japanese with the system IME and confirm a candidate with Enter: the
    message must not be sent until a second Enter.
18. **Language**: _Configure Display Language → it_, restart: the UI strings stay in English (there is
    no Italian bundle), the webview's `<html lang>` follows VS Code. In the webview
    developer tools, `document.documentElement.lang` should be `"it"` (it was hard-coded `"en"`).
19. **Incremental resync** (only if you can drop just the SSE stream, e.g. a local proxy that closes
    `GET /api/event` without restarting the server): after a reconnect, the conversation must **not**
    jump back to the top: scroll position, staged attachments and the composer draft survive, and
    only the messages produced while disconnected are appended. A server restart instead performs a
    full reload, which is expected. The merge itself is covered by the reducer unit tests and by a
    Playwright UI test that sends a `sessionDelta` and checks that staged chips are preserved.
    19b. **Subagent modal**: ask the agent to use a subagent (`Use the 'explore' subagent to list the
    files in this folder`). While it runs, the inline card shows a one-line activity; click the
    **Open subagent conversation** button on the card. Expect a modal with the child's own task,
    thoughts, tool steps and final report, with breadcrumbs ending in the agent name. Click the
    parent crumb (or press `Esc`, or click the backdrop) to return. Have that subagent spawn a
    nested one and confirm a third crumb appears and can be used to go back. Switch sessions with
    the modal open: it must close along with the child's state.
    19c. **Subagent needing approval**: ask the agent to use a subagent for a command that raises a
    permission prompt (e.g. _Use the 'explore' subagent to run git status in this folder_, with the
    default `ask` session rules). The inline card must switch from the running spinner to an amber
    _Needs your input_ badge, and an approval card labelled with the subagent's name must appear
    above the composer. Click _Allow once_: the card disappears, the indicator returns to running
    and the child finishes its report. Repeat with the subagent modal open: the approval panel must
    be visible inside the modal and the reply must still unblock the child. With auto-approve on,
    neither the card nor the indicator should appear at all.
    19d. **Background shell**: ask the agent to run a command in the background with `background:true`
    and then close its response, e.g. `for i in $(seq 1 3); do echo "check $i: $(date +%T)"; sleep 30; done`.
    After the tool card says the command moved to the background, the turn ends: expect a spinner
    **Waiting for background command** card with the command at the end of the conversation, the same
    explanation in the composer hint, and an amber dot plus that label in the session list. Do not
    send anything — when the job finishes (~90 s), the agent resumes by itself, the card disappears
    and a compact **Background command finished** notice shows `check 3: …` instead of raw XML. Click
    the header's **Sync conversation from server** and confirm the notice stays compact. A command
    backgrounded automatically after a timeout (no explicit `background:true`) must behave the same.
20. **Screen reader** (if available): with VoiceOver/NVDA, focus the composer and confirm its label,
    the session picker and the permission cards announce their role and state.
