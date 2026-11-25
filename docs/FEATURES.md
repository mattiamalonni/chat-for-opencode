# Features

The detailed behaviour behind the short list in [README.md](../README.md#features). For commands and
settings, see [REFERENCE.md](REFERENCE.md).

## Chat and sessions

- **Streaming Markdown** with syntax highlighting and copy buttons on code blocks. While a reply
  streams only its current step is expanded; when the turn ends all its folds close, leaving the
  answer visible. **Expand all steps in this turn** and each **Step N** header reopen them; choices
  are keyed per turn and never leak into another reply.
- **Collapsible reasoning** ("Thoughts") and **tool cards** that work with any tool name (input,
  output, errors). A **Todo list** appears when the agent uses OpenCode's `todowrite` tool.
- **Rollback to any turn**: OpenCode restores the files changed after it and removes that prompt,
  its reply and all later turns, while the prompt returns to the composer so you can edit and resend
  it. A native confirmation lets you keep the current files (_Messages only_). **Fork a turn** opens
  a sibling session with the history up to that point, leaving the current conversation untouched.
- **Queued messages**: plain `Enter` queues while the agent works (`delivery: queue`);
  `Ctrl/Cmd+Enter` interrupts and sends now (`delivery: steer`). The **Queued messages** panel can
  promote a prompt to _send now_, return it to the composer or remove it. A queued prompt joins the
  conversation only when the agent starts working on it. Composer drafts are per session and survive
  a window reload.
- **Subagents**: live progress stays inline. **Open subagent conversation** shows the child session
  in a modal with the same chat view; breadcrumbs navigate nested subagents and `Esc` or a backdrop
  click closes it. Its compact composer replies to the child (`Enter` queues while it works,
  `Ctrl/Cmd+Enter` sends now) and **Stop** interrupts that child without leaving the modal.
- **Turn stats**: when the agent finishes, one badge summarises start/end clock times, steps, time to
  the last step, tokens, cost and insertions/deletions. Click **+N / -N** to open all that turn's
  changes in one read-only diff. **Stop** a response and **compact** a long session from the
  composer toolbar or the command palette.
- **Session timeline**: `Cmd/Ctrl+G` opens a searchable list of the current session's turns,
  newest first, with the prompt text, time, step count, tokens and changed-line count. Selecting a
  turn scrolls to its prompt, highlights it and puts the focus back in the composer; `Esc` closes the
  picker. The list is built from the same turn data as the per-turn stats, so it also follows live
  turns, and only real prompts are shown (not the synthetic turns used while a reply streams).
- **Search and export**: `Cmd/Ctrl+Alt+F` searches titles and message bodies across every session, opens the
  hit and highlights its message, and the header exports the conversation as Markdown. In-chat search
  (`Cmd/Ctrl+F`) highlights matches in prompts, replies and tool cards with `F3`/`Shift+F3` navigation
  and an "N of M" counter. `Cmd/Ctrl+L` opens the session list (with its own title filter) while the chat has focus: `↑`/`↓`
  walk the sessions, `Enter` selects one and puts focus back in the composer. Clear **error states**
  with the action buttons (OpenCode missing, no provider, connection lost, interrupted response…).

## Context and files

- **Editor context**: the active file and selection are attached automatically as removable chips,
  with your active file icon theme's icons (including dark/light/high-contrast and glyph fonts).
- **`@` mentions** are reserved for files, with fuzzy workspace search: picking a file attaches it as
  a chip and removes the `@query` from the input.
- **Attach external files** by dragging them into the chat (hold **Shift**: VS Code otherwise opens
  the file), pasting a file into the prompt, or using the folder button's native picker. Files
  outside the workspace — and all local files when using an external endpoint — are sent inline.
- **Clickable file references**: `src/app.ts:42` in a reply, a tool's input path, a permission
  resource or a changed-file row opens the file at that line.
- **Reusable prompt library**: `/` offers eight curated prompts (explain, tests, bugs, optimize,
  document, review, problems, commit) plus your `opencode.promptLibrary` entries. Picking one fills
  the composer with `$selection`, `$file`, `$diff` and `$problems` resolved — never sent automatically.
  This is the single entry point for diagnostics, git diffs and editor selections: everything is
  attached inside the chat, and nothing is sent until you press Enter.
- **Save a reply as a project instruction**: an action beside **Copy response** appends a dated note
  to `AGENTS.md` (or a Markdown file you pick in the workspace), skipping duplicates.

## Diffs and permissions

- **Apply a reply's code to a file**: each code block has an **Apply to file** button. It targets the
  file referenced just above the block (or asks you to pick one), opens a native diff of the
  proposal and writes only after **Accept**. Full-file blocks replace the file; unified diff blocks
  are applied as patches. Paths are confined to the connected workspace.
- **Native diffs**: the **Changed files** panel lists the session's files with per-file counts and
  totals (`+N / -N`) in its header. Click the totals for all of the session's changes in a single
  read-only diff, or a row for that file alone; combined views contain only the changed hunks and
  create nothing on disk. Rows lead with the file name, then its parent folder in smaller text;
  hover for the full path.
- **Permissions and questions** live in a panel docked above the message box and are never
  auto-approved by default. The newest request is shown first and **Previous / Next** cycle through
  the queue; `1`/`2`/`3` mean Allow once / Always allow / Reject (`2` only when the rule can be
  saved). Reject or Cancel stops the reply; the two allow options continue it. Several questions
  appear one at a time with **Next question** and a single reply collects all answers. Once answered,
  a question stays in the conversation as a read-only card with its answer, outside the step folds —
  also after a reload or when the session is opened from another workspace.
- A turn started in another client on the same server (for example the TUI) has no approval UI here,
  so its pending permissions and questions are collected in the **same panel** when it belongs to this
  workspace, labelled with the session title; answering one targets that session, not the open chat.

- A **contract smoke test** on connect names the features a non-2.4.0 server cannot support, instead
  of only warning about the version number. A second, discreet **status bar item** shows the
  session's estimated context size and cost (`opencode.showUsageInStatusBar`); hover for the
  input/output/cache breakdown.

### Permission defaults

New sessions ask before editing files, running shell commands or accessing files outside the
workspace — OpenCode's own base policy would otherwise approve them silently. **Always allow** on a
permission card saves the rule for the project. These session rules take precedence over the
`permissions` in your `opencode.json`; copy the rules into `opencode.sessionPermissions` (the last
matching rule wins) or set it to `[]` and rely on your OpenCode config only.

`opencode.autoApprovePermissions`, or the **Auto-approve** toggle at the bottom of the composer,
bypasses the panel: every request is granted once, so saved rules are untouched. The toggle is
per workspace and remembered across reloads; the setting is the default for workspaces where it
was never changed. Auto-approval is off by default — only enable it when you trust unattended edits
and shell commands. Questions still always require your answer.

When several windows share one `opencode.endpoint`, each chat receives the server's whole event
stream but processes only sessions owned by its own workspace. Approval cards from another
project are therefore not shown here.

## Interface

- **Multi-root workspaces**: `@` searches files in every open folder (qualifying ambiguous names),
  attachments and file references work across folders, and session rows show their folder. One
  folder is actively connected at a time; the folder picker in the header switches while each
  folder keeps its own last session.
- **One chat, several views**: opens on the right in the Secondary Side Bar like Copilot Chat (VS
  Code 1.104+), movable anywhere with _OpenCode: Move Chat View…_ or drag and drop.
  _OpenCode: Open Chat in Editor_ opens a second, wider view of the same session.
- **Custom, searchable pickers** for models, reasoning effort and agents, grouped by provider and
  filled with what your server actually returns (e.g. _Build_ / _Plan_). `Cmd/Ctrl+M` opens the model
  picker while the chat has focus and returns focus to the composer after a selection.
- **Onboarding**: the welcome screen offers starter prompts that the current editor context can
  satisfy, or a short checklist — trust the workspace, check the bundled setup, sign in to a provider —
  with the missing action one click away.
- Keyboard friendly and screen-reader labelled; works with IMEs; English UI.

## Skills

The `/` suggestions come from OpenCode's `GET /api/skill` catalog. OpenCode discovers project and
global skills from its [supported skill locations](https://opencode.ai/docs/skills/#discovery),
including `~/.config/opencode/skills`, `~/.agents/skills` and `~/.claude/skills`. The extension
queries the server's default location so its global skills are included. A skill directory must
contain a `SKILL.md` file (or be a root-level `.md` skill) for OpenCode to discover it.

Selecting a suggestion inserts `/skill-id`; when sending, the extension converts it to `@skill-id`,
which is OpenCode's syntax for loading a skill. Other slash commands are sent unchanged. Only skill
IDs, names and descriptions reach the webview; OpenCode loads the skill content. Known `/command`
and `/skill` tokens are underlined like links in the input, so you can spot at a glance what
OpenCode will interpret; an unknown `/nope` stays plain text.
