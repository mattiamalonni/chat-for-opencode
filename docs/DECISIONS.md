# Decisions

## D1 — Direct HTTP/SSE instead of an SDK

- `@opencode-ai/sdk` (1.19.x) targets the **v1** API (`/session`, `/event`); the installed server is
  v2.2.7 and exposes everything under `/api/*`. Incompatible.
- `@opencode/client` (2.3.0) is the v2 client but: it is described on npm as a _"Private
  generation target"_, it is ESM-only (VS Code extensions load CJS), it is newer than the
  installed server (2.2.7) so generated types may not match, it pulls `@opencode/schema` and
  `@opencode/protocol` (~1.2 MB unpacked for the client alone), and its event subscriptions have
  "no replay or automatic reconnection" anyway.
- We use ~20 endpoints. A thin hand-written client with types taken from the server's own
  `/openapi.json` (saved in `docs/openapi-2.2.7.json`) is small, testable against a mock server,
  and lets us implement reconnection exactly as we need.

## D2 — Managed server: random password via `OPENCODE_PASSWORD`

v2 servers always require Basic auth. Documented env var `OPENCODE_PASSWORD` sets it; we
generate 24 random bytes per spawn (base64url) and keep them in memory only. `--port 0` lets the OS pick a
free port; the URL is parsed from the `server listening on <url>` stdout line, then `/api/info` is
polled as a health check.

## D3 — One process per workspace folder, cwd = folder

The server's default location is its cwd, and sessions are created with an explicit
`location.directory`, so each folder's server sees only its own project. Processes start lazily
(first time the chat view needs that folder).

## D4 — Reducer in the webview, server as source of truth

History is re-fetched on view creation and after every SSE reconnect; live events are forwarded
unchanged. This keeps the host stateless w.r.t. message content, avoids `retainContextWhenHidden`
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

Cmd/Ctrl+N, Cmd/Ctrl+F and Cmd/Ctrl+R are the chords the webview claims from VS Code: a `window`
**capture-phase** listener stops them before the preload's bubble listener can forward `did-keydown`
to the workbench (where they would be "New Untitled File" / "Find" / "Open Recent") and respectively
posts `newSession`, opens and focuses the chat's message search, or posts `sync` to reload the
session from the server (with the same busy guard as the header's sync button). Because key events
only reach the webview while it is focused, this applies only when the chat has focus.
Shift/Alt/Ctrl-on-mac variants are left alone (e.g. Cmd/Ctrl+Shift+F still runs VS Code's
"Find in Files").

## D8 — Todo list from `todowrite`

No todo endpoint/event exists; with `experimental.todo` the agent uses a `todowrite` tool whose
input contains `todos[]`. The UI shows the latest call's list.

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

## D9 — Permission requests are rendered in the attention overlay, not in the tool card

`permission.asked.source.id` equals the tool call id, so the request is attached to that tool card
_as a marker_; requests without a source are shown at the end of the conversation. The actionable
`PermissionCard` is rendered once in the attention overlay above the composer, where it cannot be
hidden inside a folded step or duplicated across cards. The tool card keeps only the `attention`
marker pointing to it.

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

## D16 — Workspace Trust blocks process and secret access, not just configuration

`untrustedWorkspaces.supported: "limited"` restricts `opencode.executablePath` and `opencode.endpoint`,
but VS Code would still let the extension spawn the default `opencode` binary and read `SecretStorage`.
The `isTrusted` check therefore sits before `server.ensure()` / `server.restart()` and before
`readAuthLogins()`, and publishes an error card with a _Trust workspace_ action. VS Code 1.99 only
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
