# Decisions

## D4 — Reducer in the webview, server as source of truth

History is re-fetched on view creation and after every event-stream resubscribe; live events are
forwarded unchanged. This keeps the host stateless w.r.t. message content, avoids `retainContextWhenHidden`
(memory), and makes the reducer a pure function testable in Node.

## D5 — Preact + marked + DOMPurify + highlight.js (common subset)

Preact is ~4 KB; marked is fast and dependency-free; DOMPurify because model output may contain
HTML; highlight.js `lib/common` covers ~35 languages and works with VS Code theme colours via CSS
variables. Total webview bundle stays well under 1 MB.

## D6 — Diffs from patches

The server returns unified patches (tool `metadata.files[]`, `permission.asked.metadata.files[]`,
`GET /session/{id}/diff`). The extension reconstructs the other side by applying the patch to the
current file content (forward for proposed changes, reverse for applied ones) and opens
`vscode.diff` with virtual documents. If the patch doesn't apply cleanly we show the raw patch.

For a whole turn or session, `openDiffs` does **not** read the files: `hunksSides` builds the two
sides from the patches' changed hunks (plus context) with a `===== file =====` header per file. The
native diff editor then shows only the modified regions in a single read-only view, and no file is
created on disk. The per-turn counts are stored on `TurnStats` when edits complete and recomputed
from history on load, because the post-turn reconciling resync can replace the live tool metadata.

## D7 — Keyboard isolation

The VS Code webview preload forwards every `keydown` that reaches `window` (bubble phase) to the
workbench keybinding service (verified in `src/vs/workbench/contrib/webview/browser/pre/index.html`).
The composer calls `stopPropagation()` for keys it owns (plain keys, Ctrl/Alt combos such as
Ctrl+J, Ctrl+R, Ctrl+K, AltGr chars), and lets a small allowlist through (clipboard, undo/redo,
select all, Cmd/Ctrl+Shift+P, Cmd/Ctrl+P, F-keys, …) so the preload's Electron clipboard handling
keeps working — VS Code implements Select All for webviews via `webview.selectAll()` →
`execCommand('selectAll')`, so `Cmd/Ctrl+A` must reach the preload too. IME:
`isComposing`/`keyCode 229`/`key === "Process"` never trigger send.

Cmd/Ctrl+N, Cmd/Ctrl+F, Cmd/Ctrl+R, Cmd/Ctrl+L and Cmd/Ctrl+M are the chords the webview claims from
VS Code: a `window` **capture-phase** listener stops them before the preload's bubble listener can
forward `did-keydown` to the workbench (where they would be "New Untitled File" / "Find" /
"Open Recent" / "Expand Line Selection" / "Toggle Tab Focus Mode") and respectively posts
`newSession`, opens and focuses the chat's message search, posts `sync` to reload the session from
the server (with the same busy guard as the header's sync button), toggles the in-chat session list,
or opens the model picker. Because key events only reach the webview while it is focused, this
applies only when the chat has focus.
Shift/Alt/Ctrl-on-mac variants are left alone (e.g. Cmd/Ctrl+Shift+F still runs VS Code's
"Find in Files").

## D8 — Todo list from `todowrite`

No todo endpoint/event exists; with `experimental.todo` the agent uses a `todowrite` tool whose
input contains `todos[]`. The UI shows the latest call's list.

## D9 — Permission requests are rendered in the attention overlay, not in the tool card

`permission.asked.source.id` equals the tool call id, so the request is attached to that tool card
_as a marker_; requests without a source are shown at the end of the conversation. The actionable
`PermissionCard` is rendered once in the attention overlay above the composer, where it cannot be
hidden inside a folded step or duplicated across cards. The tool card keeps only the `attention`
marker pointing to it. A completed `question` call is different: it is reclassified as prose in
`conversationModel.ts` and shown in the transcript as a read-only question/answer card. Questions
come from `input.questions` and answers from `metadata.answers` (or the tool's text result), both
stored by the server in session history. Until then the call stays an ordinary tool card with the
attention marker; only the pending form is actionable in the overlay, so there is exactly one place
to answer.

## D10 — Secondary Side Bar container

`contributes.viewsContainers.secondarySidebar` exists only from VS Code 1.104 (checked in
`viewsExtensionPoint.ts` at tags 1.103.0 / 1.104.0). We keep `engines.vscode ^1.99.0` and contribute
only that container: on 1.99–1.103 VS Code logs a warning and places the view in the Explorer
(verified by the integration suite on 1.99.3), from where it can be moved with
_OpenCode: Move Chat View…_ (`workbench.action.moveFocusedView`). An extra Activity Bar container
was rejected because it would create a duplicate, empty icon on new VS Code versions.

## D11 — Custom pickers instead of `<select>`

Native selects render with OS chrome inside webviews and cannot show descriptions, groups or a
search box. `Picker` (button + `listbox` popup) follows the ARIA listbox pattern (ArrowUp/Down,
Home/End, Enter, Escape, type-to-search for the model list) and is styled with `--vscode-quickInput*`
variables so it looks like VS Code's own quick picks.

## D12 — Incremental resync via a descending history page

The event stream is live-only (no `Last-Event-ID` replay), and the history cursor is opaque and can be
invalidated by compaction. We therefore store the newest history message id and, on reconnect,
request `order=desc` once: finding the known id gives an exact tail with **one** small request.
Anything else (id missing, request failed) falls back to the full load, so correctness never depends
on the optimisation. The webview merges the tail by message id (`sessionDelta`) instead of rebuilding
the state, keeping conversation-scoped UI state intact.

## D13 — Adapter + generated raw types instead of trusting the snapshot

`checkContract` reports raw shape drift; `src/shared/adapter.ts` converts raw payloads to the
canonical types used by the reducer, filling optional fields and dropping malformed entries. Raw
wire types are generated from the checked-in OpenAPI snapshot (`npm run gen:types`, verified in CI).
The two are deliberately separate: the adapter keeps the UI usable, the contract report keeps the
version warning honest. Supporting a new server version should extend the adapter, not the reducer.

## D14 — File icons are resolved from the user's icon theme, inlined as data URIs

VS Code has no API returning "the themed icon for this path": `ThemeIcon.File` only works in views
VS Code renders itself (tree, quick pick, timeline), and codicons cover only a handful of file types.
To make file chips and changed-file rows match the Explorer we therefore read `workbench.iconTheme`,
find the contributing extension in `vscode.extensions.all` (built-in Seti included), parse its JSON
with `vscode.workspace.fs.readFile`, and apply the documented association order: file name with a
parent path segment → file name → extension with parent → extension → language id → default. The
`light` / `highContrast` sections and `extends` are merged, and `files.associations` overrides the
language inferred from the path. The language id is reconstructed from installed extensions'
`contributes.languages` because the webview only knows a path — Seti, for example, maps TypeScript
only through `languageIds`, not `fileExtensions`.

Icons are requested lazily by the webview (one batch per frame), cached by the host and invalidated
when the icon theme, color theme, associations or installed extensions change. SVG and glyph-font
assets are inlined as data URIs rather than exposed with `asWebviewUri`: that avoids changing
`localResourceRoots` dynamically (the webview view can be recreated) and keeps the standalone UI
harness — which has no `asWebviewUri` — working unchanged. The cost is a base64 payload (Seti's
font is ~37 KB → ~50 KB), sent only with icon responses.

## D15 — Subagent input is surfaced in the parent chat, with the child's session id

A subagent has no composer and no approval UI of its own. Its `permission.asked` / `form.created`
events are stored in the child's `ChatState`, then collected into the parent's attention overlay
(labelled with the child's name). The cards reply with `request.sessionID` / `form.sessionID`, so the
existing protocol reaches the child without any new host message. The modal docks its own overlay
because its backdrop covers the chat's one; the main overlay drops child requests while the modal is
open so the same request is never rendered twice. Auto-approve is a property of the chat, not of the
session, so children inherit the parent's toggle. To keep the thread honest, the inline subagent card
shows an amber waiting marker while its child is blocked — the actionable card still lives only in
the overlay.

## D16 — Workspace Trust gates host creation and secret access

`untrustedWorkspaces.supported: "limited"` restricts `opencode.endpoint`.
The `isTrusted` check therefore sits before host creation and before any
credential listing (`ChatController.credentials()` / `GET /api/credential`), and publishes an error
card with a _Trust workspace_ action. The API
exposes `onDidGrantWorkspaceTrust`, so gaining trust reconnects without a reload while losing trust
takes effect on the next reload (all entry points re-check `isTrusted` in the meantime).

## D17 — One chat, several views; generation guards for async state

Host messages fan out to a `Set` of live webviews (sidebar + editor tabs) instead of a single view,
with per-view subscriptions and a `WebviewPanelSerializer` for restore. All views show the same
session; the composer state stays in each webview. Async work is invalidated by generation tokens
per concern (`connectGen`, `loadGen`, `childGen`, `executionGen`) plus client identity in `resync`;
`loadedConnection` records that `loadAll()` actually completed, so a failed first load on an external
server cannot make later reconnects no-ops. The first prompt uses a `fast` load path that skips the
catalog/session-list/diff round-trips on the critical path and runs them fire-and-forget instead.

## D18 — Applying a code block is a reviewable proposal, never a direct write

The webview sends only the block text plus the nearest file reference it saw in the reply. The host
validates that path against the workspace (including the real-path check), reads the current file,
and computes a proposal: full-file blocks are used verbatim, unified diffs go through the existing
`applyPatch`. A patch that does not apply is rejected before any UI is shown. The proposal opens as
a native diff through `DiffService.openProposal`, and the file is written with a `WorkspaceEdit`
only after a separate **Accept** in a notification; **Reject** or dismissing it writes nothing.
This keeps the "nothing without review" policy of the permission cards, and lets the whole flow be
unit-tested behind injected hooks (`ApplyCodeService`) rather than driving native notifications.

## D19 — Prompt variables are resolved in the host, not the webview

A `/` prompt can refer to the selection, the active file, the working-tree diff or the editor
diagnostics. The webview has no access to git or to diagnostics, so selecting a prompt posts only its
`id`; the host resolves `$selection` / `$file` from the active editor, formats the working-tree diff
and the diagnostics into the prompt text, then posts the existing `prefillDraft` message. This also
keeps user-defined prompts (from `opencode.promptLibrary`) on the same path as the curated ones and
makes the resolution a pure `resolvePromptVariables` function with unit tests.

## D20 — Project instructions are appended as dated Markdown notes

A useful reply is often a project rule worth keeping. The reply action posts only the visible
response text; the host appends a dated `## OpenCode note` section to `AGENTS.md` by default, with a
QuickPick for another Markdown file inside the workspace. Notes already present are not duplicated,
and replies are capped at 2 000 characters so a long answer cannot take over the file. The
`ProjectInstructionService` keeps formatting, deduplication and the no-folder / outside-workspace
refusals in pure hooks; the host only resolves the target path and performs the `WorkspaceEdit`.

## D21 — Multi-root is a scope widening, not a second connection

`ServerRegistry` already keeps one handle per folder and the controller already persists the last
session per folder, so a full multi-connection chat was unnecessary for the main monorepo pain
point: not seeing the rest of the repository. `FileIndex` scans every workspace folder and
qualifies ambiguous paths with the folder name; path validation accepts any folder the user
explicitly opened (still after real-path resolution, so `../` and symlink escapes remain blocked);
session summaries carry their folder name. The active folder stays the single join root for
relative paths and the only one bound to a client/stream. Switching folders keeps the existing,
well-tested teardown path and restores that folder's last session via its own storage key. Adding
or removing a folder rebuilds the index instead of silently leaving stale results.

## D22 — Session list status is derived from history, not from server events

The three dots in the session list are produced by one classification of the last `user`/`assistant`/
`idle` message (`sessionTurnStatus`): an `idle` outcome, an unfinished assistant, or a completed
assistant carrying an `error`. Bookkeeping messages (compaction, notices, …) must not hide that
terminal message, and timestamps are kept only as a fallback when history is unavailable. This keeps
the red _Failed_ / _Interrupted_ indicator correct after a VS Code reload and when the turn ended on a
server that never wrote its `idle` marker, and it clears naturally when the next prompt arrives — no
separate event-driven flag can go stale. `needsInput` is the deliberate exception: pending permissions
and forms are not messages, have ids that never appear in history, and cannot be distinguished from a
tool that is merely running, so the amber dot still comes from the live permission/form endpoints.
`SessionListService` therefore fetches history for every listed session but only asks for those
endpoints when the session can have a pending request.
