# Manual test (real VS Code + real `opencode serve`)

Prerequisites: OpenCode v2 on `PATH` (`opencode --version`), a provider configured
(`opencode models` lists models), the `.vsix` built with `npx @vscode/vsce package`.

1. **Install**: `code --install-extension chat-for-opencode-0.1.0.vsix`, reload the window.
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
   Expect "Response interrupted."
6. **Permission + diff**: send `Change a.txt so it contains b instead of a`. An `edit` tool card shows
   *Permission required* with `a.txt`. Click the file row → native diff `a` → `b` (proposed).
   Click **Allow once**. The file changes; *Changed files (1)* appears above the input; clicking
   the file opens the applied diff.
7. **Reject**: ask for another edit and press **Reject**: the tool card turns red, file unchanged.
8. **Context**: open `a.txt`, select the line. Chips `a.txt (Current file)` and `a.txt:1` appear;
   remove one with ×; send `What does the selection contain?`. The user bubble lists the attachment.
   Right-click → *Add Selection to Chat* adds a chip.
9. **@ mention**: type `@a.t`, choose `a.txt` with ↓/Enter.
10. **Sessions**: click the session title → list; create a new session with `+`; switch back.
11. **Resume after restart**: quit VS Code completely (`Cmd/Ctrl+Q`), check `ps aux | grep "opencode serve"`
    shows no process started by the extension, reopen the folder and the sidebar. The last session
    and its messages are restored.
12. **Errors**: set `opencode.executablePath` to `/nope` → banner *OpenCode is not installed…* with
    *Install OpenCode / Open settings / Show logs*. Reset the setting → reconnects.
    Kill the server process (`kill <pid>` from the logs) → banner "Reconnecting…" then back to normal.
13. **Keyboard**: in the input press `Ctrl+J` / `Ctrl+R` / `Ctrl+K`: the panel must **not** toggle and the
    recent-files picker must **not** open. `Cmd/Ctrl+Shift+P` still opens the command palette;
    copy/paste work.
14. **IME** (if available): type Japanese with the system IME and confirm a candidate with Enter: the
    message must not be sent until a second Enter.
15. **Language**: *Configure Display Language → it*, restart: the UI is in Italian.
