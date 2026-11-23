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
  in a read-only modal with the same chat view; breadcrumbs navigate nested subagents and `Esc` or
  a backdrop click closes it.
- **Turn stats**: when the agent finishes, one badge summarises start/end clock times, steps, time to
  the last step, tokens, cost and insertions/deletions. Click **+N / -N** to open all that turn's
  changes in one read-only diff. **Stop** a response and **compact** a long session from the
  composer toolbar or the command palette.
- **Search and export**: `Cmd/Ctrl+Alt+S` quick-switches sessions (recent first, typing searches all
  conversations), `Cmd/Ctrl+Alt+F` searches titles and message bodies across every session, opens the
  hit and highlights its message, and the header exports the conversation as Markdown. In-chat search
  (`Cmd/Ctrl+F`) highlights matches in prompts, replies and tool cards with `F3`/`Shift+F3` navigation
  and an "N of M" counter. The session list has its own title filter. Clear **error states** with the
  action buttons (OpenCode missing, no provider, connection lost, interrupted response…).

## Context and files

- **Editor context**: the active file and selection are attached automatically as removable chips,
  with your active file icon theme's icons (including dark/light/high-contrast and glyph fonts).
- **`@` mentions** with fuzzy workspace search: picking a file attaches it as a chip and removes the
  `@query` from the input. **Add Selection to Chat** / **Add File to Chat** work the same way.

- **Context sources on demand**: `@problems`, `@git`, `@terminal`, `@openEditors` or `@symbol`, or
  the **Add context** button next to the composer's folder button. Their content is sent inline, so
  it works even when the server's filesystem is not yours.
- **Attach external files** by dragging them into the chat (hold **Shift**: VS Code otherwise opens
  the file), pasting a file into the prompt, or using the folder button's native picker. Files
  outside the workspace — and all local files when using an external endpoint — are sent inline.
- **Clickable file references**: `src/app.ts:42` in a reply, a tool's input path, a permission
  resource or a changed-file row opens the file at that line.
- **Editor actions**: _Fix with OpenCode_ and _Explain with OpenCode_ Quick Fixes on diagnostics
  (up to three at a time), **Ask OpenCode About This File** in the editor title bar, _Explain / Find
  bugs / Write tests / Optimize Selection_ in the context menu. Everything prefills the chat;
  nothing is sent until you press Enter.
- **Review your uncommitted work**: _OpenCode: Review My Changes_ and _OpenCode: Write Commit Message_
  send the staged + unstaged git diff with a review or Conventional Commit prompt. Untracked files
  are listed by name and diffs are capped so a huge working tree cannot flood the context.
- **Reusable prompt library**: `/` offers eight curated prompts (explain, tests, bugs, optimize,
  document, review, problems, commit) plus your `opencode.promptLibrary` entries. Picking one fills
  the composer with `$selection`, `$file`, `$diff` and `$problems` resolved — never sent automatically.
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
  appear one at a time with **Next question** and a single reply collects all answers.
- A **contract smoke test** on connect names the features a non-2.3.0 server cannot support, instead
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
per chat and remembered across reloads; the setting is the default for chats where it was never
changed. Auto-approval is off by default — only enable it when you trust unattended edits and shell
commands. Questions still always require your answer.

## Interface

- **Multi-root workspaces**: `@` searches files in every open folder (qualifying ambiguous names),
  attachments and file references work across folders, and session rows show their folder. One
  folder is actively connected at a time; the folder picker in the header switches while each
  folder keeps its own last session.
- **One chat, several views**: opens on the right in the Secondary Side Bar like Copilot Chat (VS
  Code 1.104+), movable anywhere with _OpenCode: Move Chat View…_ or drag and drop.
  _OpenCode: Open Chat in Editor_ opens a second, wider view of the same session.
- **Custom, searchable pickers** for models, reasoning effort and agents, grouped by provider and
  filled with what your server actually returns (e.g. _Build_ / _Plan_).
- **Onboarding**: the welcome screen offers starter prompts that the current editor context can
  satisfy, or a short checklist — trust the workspace, install the CLI, sign in to a provider —
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
