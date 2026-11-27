# chat-for-opencode — Specification

## Goal

A VS Code extension that provides a Copilot-style chat sidebar for **OpenCode v2**. OpenCode itself
is hosted in-process through `@opencode/sdk` (no CLI, child process or listener): the extension never
stores provider API keys itself and sends no telemetry. Its Connect panel collects a key or starts
an OAuth/command flow and sends the credential once to OpenCode, the sole owner of
credential storage.

## Architecture

```
┌──────────────────────── VS Code extension host (Node) ────────────────────────┐
│ extension.ts ── composition root; commands.ts registers the commands          │
│   ServerRegistry ── one ServerHandle per workspace folder                     │
│     ManagedServer   `OpenCode.create()` from the bundled SDK                  │
│                     one in-process host, folder = location, closed on exit    │
│     ExternalServer  `opencode.endpoint` + password from SecretStorage         │
│   OpenCodeClient (client/http.ts)  facade over OpenCode's generated client    │
│     adapter      (shared/adapter)  raw wire shapes -> canonical UI types      │
│     sdkContract  (shared/)         compile-time check against generated types │
│   EventStream    (client/sse.ts)   events.subscribe() + resync on reconnect  │
│   ChatController (chat/controller.ts)                                         │
│     glue between server and webview, session persistence (workspaceState),    │
│     editor context, @-file search, skill catalog, diff opening                │
│   DiffService (chat/diff.ts)  patch → before/after virtual docs → vscode.diff │
└───────────────────────────────▲───────────────────────────────────────────────┘
                     postMessage │ (typed protocol, src/shared/protocol.ts)
┌───────────────────────────────▼───────────── Webview View (Secondary Side Bar) ──────────┐
│ Preact UI (src/webview)                                                       │
│   chat reducer (src/shared/chatReducer/) folds history + live events        │
│   markdown (marked + DOMPurify) + highlight.js                                │
│   composer: context chips, @-file mentions, /-skill suggestions, IME-safe Enter│
└───────────────────────────────────────────────────────────────────────────────┘
```

OpenCode is the source of truth. The webview reducer is rebuilt from session history when the view
is (re)created, then kept live by forwarding the session's SDK events. After a stream reconnect or a completed turn the controller looks for the last
known message id in a descending history page (`messagesNewerThan`): if the overlap is known it
posts a `sessionDelta` with only the new messages, preserving scroll position, staged attachments and
drafts; if history was trimmed/compacted it falls back to a full `session` load. The webview
therefore doesn't need `retainContextWhenHidden`; the composer keeps a draft per session in
`workspaceState` through the `drafts` / `saveDraft` messages.

An abort, a rejected permission or a cancelled question posts a **local idle** to the webview so the
composer unlocks even when OpenCode emits no terminal event. Every resync path keeps it unlocked via
an `executionGen` guard until the next turn starts, so stale server timestamps cannot bring the Stop
button back. Queued prompts are consumed in order at `execution.started`: each opens its own turn
under the real user message id and is delivered even when its `inbox.delivered` event was missed.

The event stream is the SDK's `events.subscribe()` async iterable. It is live-only (no replay),
so when it ends the supervisor backs off, resubscribes and resyncs from history. A generation token
prevents a stale stream or a late `stop()` from overwriting a newer connection. The
embedded host has no child process, port, password or orphaned-server record to manage.

Raw server payloads are normalised by `src/shared/adapter.ts` before reaching the reducer. The raw
wire shapes for the 2.4.0 snapshot are generated from `docs/openapi-2.4.0.json` by
`npm run gen:types` (CI checks that the generated file is current) and serve as the reference for
those normalisers. The contract smoke test observes the **raw** values, so an adapter that
drops malformed entries cannot hide an unsupported server.

## Folder layout

```
src/
  extension.ts            activation and composition root
  commands.ts             command/palette registration
  auth/                   `opencode auth list` parsing
  status/                 usage and account status-bar presenters
  sdk/                    bridge to the bundled SDK (own `dist/sdk.mjs`, imported on first connect)
  server/                 embedded-host lifecycle / external endpoint
  client/                 generated-client facade + event stream, API types
  chat/                   ChatController, ViewProvider, diff, context, feature services in services/
  shared/                 code shared by host and webview (protocol, reducer, patch, keys);
                          the reducer is split into modules under chatReducer/
  webview/                Preact app (App orchestrator + focused view modules, bundled separately)
test/
  unit/                   vitest unit tests (client, sse, reducer, patch, keys, server)
  mock/                   mock OpenCode HTTP API and event stream
  integration/            @vscode/test-electron suite (runs against the mock server)
  e2e/                    real embedded SDK test (model tests skip without a provider)
  ui/                     Playwright test of the webview with a fake VS Code host
package.nls.json          manifest strings (English); `vscode.l10n.t` uses the source strings inline
docs/                     documentation index, API notes, decisions, limits, test/release docs
```

## Extension ↔ webview protocol

All messages are JSON objects with a `type` discriminator, defined in `src/shared/protocol.ts`.

### Message contract

`HostMessage` and `WebviewMessage` in `src/shared/protocol.ts` are the single source of truth for
every message and payload; incoming webview messages are validated with `isWebviewMessage`. The main
flows are:

- **Connection and session**: `init`, `connection`, `catalog`, `sessions`, `session`, `sessionDelta`, `event`, `context`, `synced`.
- **Turns and prompts**: `send`, `abort`, `compact`, `revertTo`, `fork`, `regenerate`, `action`.
- **Inline cards**: `permissionReply`, `formReply`, `formCancel`, `inbox`, `setInboxDelivery`, `cancelInbox`.
- **Files and attachments**: `addAttachment`, `dropFiles`, `pickFiles`, `openFile`, `openAttachment`, `openLink`, `openDiff`, `openDiffs`, `fileIcons`.
- **Subagents**: `subagent`, `subagentEvent`, `linkSubagent`, `refreshSubagent`.
- **UI state**: `autoApprove`, `drafts`, `draftRestored`, `prefillDraft`, `reverted`, `forked`, `revealMessage`, `dropzone`, `notice`, `focusInput`.

Composer drafts are mirrored to the host and persisted in `workspaceState`; `vscode.setState` remains
a fast local cache.

The composer splits its mention popup by trigger: `@` searches workspace files, and `/` covers skills,
prompts and commands. When a file is picked from the `@` mention results, the composer removes the
`@query` from the text and adds the file as a chip: the prompt carries the attachment through the
`attachments` field, not through an `@name` in the text.
`@skill` and `/command` selections instead keep their token in the text, which OpenCode resolves when
the prompt is sent. Tokens matching a known command or skill are underlined like links by a
transparent overlay above the textarea; unknown ones stay plain text.

`UiError = { kind, message, detail?, actions: ActionId[], target?: { kind: "permission" \| "form", id } }`, kinds:
`startFailed`, `unauthorized`, `noProvider`, `connectionLost`, `promptFailed`,
`noWorkspace`, `untrustedWorkspace`, `requestFailed`.

The `skills` catalog is fetched from `GET /api/skill` without a workspace-location override so
OpenCode includes its global skill sources. The webview receives only each skill's ID, name and
description. Selecting `/skill-id` converts it to `@skill-id` when sending, which is the syntax
OpenCode uses to load a skill; unrelated slash commands remain unchanged.

### Step folds

OpenCode emits one assistant message per step. Each step's prose stays in the conversation while its
thoughts and tool calls go into a collapsible labelled **Step N** (or **Steps N–M** when consecutive
textless steps share one fold). Prose breaks a run, so a thought emitted after a sentence stays below
it in its own fold. An answered `question` tool call is prose too: it stays visible at the point where
it was asked, with its answer read from the server's tool result, so it survives a reload or another
workspace. While pending, the call keeps its ordinary tool card with an attention marker pointing to
the overlay, so the actionable card is still shown only once.

While a turn streams, only the current step's fold is expanded. As soon as the turn ends, every fold
in it closes — including the last step's — leaving the answer's prose on screen. Finished turns
therefore start folded; **Expand all / Collapse all steps in this turn** toggles them together and
each header toggles its own fold. Search temporarily opens folds that contain a hit. Manual overrides
are keyed by the turn's first assistant message id plus the fold indices, so expanding or collapsing
one reply never changes the automatic state of another.

### Changed files and cost

`changedFiles` normally comes from `GET /session/{id}/diff`, but that endpoint is empty outside git
repositories. The webview therefore merges it with patches from completed tool calls
(`metadata.files`, via `selectToolChangedFiles`); the server diff wins for the same path. OpenCode
diffs from a session's start snapshot to the **current** HEAD/working tree, so the response also
contains files committed by other sessions after this one started. Only paths this session actually
touched (step `files` or completed tools' `metadata.files`) are admitted from that response; the
host also drops a diff that resolves after the active session changed. The
`session.usage.updated` event's cost is kept in `ChatState.usage` and shown in the composer's
context meter. Changing session (new/folder switch/select/delete) clears conversation-scoped webview
state — drafts, staged attachments and the changed-files panel — while a same-session resync keeps it.
Changed-file rows render only the path's basename, followed by the parent directory (with its trailing
separator) in smaller, muted text; the full path stays in the row's hover tooltip.

Each `TurnStats` also keeps the files edited in that turn (path, patch, additions, deletions). The
counts are captured when a tool completes and rebuilt from history on load, so the post-turn
reconcile — which replaces live messages with server history that may omit `metadata.files` — cannot
wipe them. Both the turn summary bar and the **Changed files** header show `+additions / -deletions`;
clicking them posts `openDiffs`. `DiffService` then builds two virtual documents from the patches'
hunks only (`hunksSides`, with a `===== file =====` header per file) and opens one read-only
`vscode.diff`, so the view contains just the changed regions and nothing is written to disk.

## Security

- Webview CSP: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource};
  img-src ${cspSource} data:; font-src ${cspSource}`. No remote scripts, no `connect-src`
  (the webview never talks to the server directly).
- Markdown HTML is sanitised with DOMPurify _before_ prose is linkified, so a crafted
  `<a data-file>`/`data-action` in a reply cannot become a clickable file link or a fake code-copy
  button. Regression-tested in a real browser.
- File references from model output are confined to the workspace folder. `openFile`, attachment
  chips and `DiffService.open` all resolve the target and reject paths that escape it (including
  `../` sequences), so untrusted tool metadata cannot make the host read an arbitrary local file.
- File-icon theme assets are read from the installed theme only; paths are resolved (no `..` escape)
  and remote `https:` assets are not fetched — the extension makes no network calls beyond the
  configured server and the webview CSP allows no remote images or fonts.
- Remote endpoint password: stored in `SecretStorage`, never in the extension state.
- The embedded host opens no listener.
- Permissions and questions are only auto-answered when the user explicitly opts in
  (`opencode.autoApprovePermissions` or the per-workspace toggle); both default to off. Questions
  (forms) always require a user answer, even with auto-approval enabled.
- With a shared endpoint, each chat filters the live event stream by the session's workspace, so
  approvals and notifications from another project are never shown in this window.
