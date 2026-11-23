# chat-for-opencode — Specification

## Goal

A VS Code extension that provides a Copilot-style chat sidebar for **OpenCode v2**. It is a pure
client of `opencode serve`: it never re-implements the agent, never reads or stores provider API
keys and sends no telemetry.

## Architecture

```
┌──────────────────────── VS Code extension host (Node) ────────────────────────┐
│ extension.ts ── registers commands, view, config listeners                     │
│   ServerRegistry ── one ServerHandle per workspace folder                     │
│     ManagedServer   spawn `opencode serve --hostname 127.0.0.1 --port 0`      │
│                     cwd = folder, env OPENCODE_PASSWORD = random per spawn    │
│                     health check, auto-restart w/ backoff, clean shutdown     │
│     ExternalServer  `opencode.endpoint` + password from SecretStorage         │
│   OpenCodeClient (client/http.ts)  typed fetch wrapper (Basic auth)           │
│     adapter      (shared/adapter)  raw wire shapes -> canonical UI types      │
│                                    (generated from docs/openapi-2.3.0.json)   │
│   EventStream    (client/sse.ts)   SSE parser + auto-reconnecting stream      │
│   ChatController (chat/controller.ts)                                         │
│     glue between server and webview, session persistence (workspaceState),    │
│     editor context, @-file search, skill catalog, diff opening                │
│   DiffService (chat/diff.ts)  patch → before/after virtual docs → vscode.diff │
└───────────────────────────────▲───────────────────────────────────────────────┘
                     postMessage │ (typed protocol, src/shared/protocol.ts)
┌───────────────────────────────▼───────────── Webview View (Secondary Side Bar) ──────────┐
│ Preact UI (src/webview)                                                       │
│   chat reducer (src/shared/chatReducer.ts) folds history + live events        │
│   markdown (marked + DOMPurify) + highlight.js                                │
│   composer: context chips, @-file mentions, /-skill suggestions, IME-safe Enter│
└───────────────────────────────────────────────────────────────────────────────┘
```

The **server is the source of truth**. The webview reducer is rebuilt from
`GET /api/session/{id}/message` when the view is (re)created, then kept live by forwarding the
session's SSE events. After a stream reconnect or a completed turn the controller looks for the last
known message id in a descending history page (`messagesNewerThan`): if the overlap is known it
posts a `sessionDelta` with only the new messages, preserving scroll position, staged attachments and
drafts; if history was trimmed/compacted it falls back to a full `session` load. The webview
therefore doesn't need `retainContextWhenHidden`; the composer keeps a draft per session in
`vscode.setState`.

An abort, a rejected permission or a cancelled question posts a **local idle** to the webview so the
composer unlocks even when OpenCode emits no terminal event. Every resync path keeps it unlocked via
an `executionGen` guard until the next turn starts, so stale server timestamps cannot bring the Stop
button back. Queued prompts are consumed in order at `execution.started`: each opens its own turn
under the real user message id and is delivered even when its `inbox.delivered` event was missed.

The SSE stream has two watchdogs — an **idle timeout** (no event or heartbeat) and a **connect
timeout** (`connectTimeoutMs`, waiting for response headers). Either aborts the request, so a server
that stalls before replying takes the normal reconnect-with-backoff path instead of freezing the
chat. Managed-server lifecycle uses a generation token so a `stop()` still awaiting a child kill
cannot overwrite a replacement's state or trigger a spurious auto-restart, and a PID record is
removed only if it still names the child that is exiting.

Raw server payloads are normalised by `src/shared/adapter.ts` before reaching the reducer. The raw
wire shapes for the 2.3.0 snapshot are generated from `docs/openapi-2.3.0.json` by
`npm run gen:types` (CI checks that the generated file is current) and serve as the reference for
those normalisers. The contract smoke test still observes the **raw** values, so an adapter that
drops malformed entries cannot hide an unsupported server.

## Folder layout

```
src/
  extension.ts            activation, commands
  server/                 process management (managed / external)
  client/                 HTTP client, SSE parser + stream, API types
  chat/                   ChatController, ViewProvider, diff, context, l10n strings
  shared/                 code shared by host and webview (protocol, reducer, patch, keys)
  webview/                Preact app (bundled separately for the browser)
test/
  unit/                   vitest unit tests (client, sse, reducer, patch, keys, server)
  mock/                   mock OpenCode server (HTTP + scripted SSE)
  integration/            @vscode/test-electron suite (runs against the mock server)
  e2e/                    real `opencode serve` test (skipped when no provider)
  ui/                     Playwright test of the webview with a fake VS Code host
package.nls.json          manifest strings (English); `vscode.l10n.t` uses the source strings inline
docs/                     documentation index, API notes, decisions, limits, test/release docs
```

## Extension ↔ webview protocol

All messages are JSON objects with a `type` discriminator, defined in `src/shared/protocol.ts`.

### Host → webview

| type            | payload                                                                                                                                 | when                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `init`          | `strings`, `platform`, `folders`, `activeFolder?`, `issuesUrl?`                                                                         | after `ready`                                                                                     |
| `connection`    | `status: idle\|starting\|connected\|reconnecting\|error`, `error?`, `version?`, `compatibility?`, `compatibilityDismissed?`             | any status change                                                                                 |
| `catalog`       | `models`, `agents`, `skills`, `selectedModel?`, `selectedAgent?`                                                                        | after connect / config change                                                                     |
| `sessions`      | `items: SessionSummary[]` (with `folder?` in multi-root), `currentId?`, `hasMore?`                                                      | list changed / more pages loaded                                                                  |
| `session`       | `session: SessionPayload \| null` (`id`, `title?`, `agent?`, `model?`, `busy`, normalised `messages`, `permissions`, `forms`, `usage?`) | session loaded / full resync                                                                      |
| `sessionDelta`  | `delta: SessionDelta` (tail `messages` + updated pending items/usage)                                                                   | reconnect/reconcile found no or few new messages; merged by id, does not reset conversation state |
| `event`         | `event` (raw server SSE event for the current session)                                                                                  | live                                                                                              |
| `context`       | `items: ContextItem[]`                                                                                                                  | active editor / selection changed                                                                 |
| `promptCatalog` | `items: PromptDefinition[]` (curated + `opencode.promptLibrary`, posted on init)                                                        | after `ready`                                                                                     |
| `fileResults`   | `query`, `items`                                                                                                                        | answer to `searchFiles`                                                                           |
| `addAttachment` | `item`                                                                                                                                  | "Add selection to chat" command                                                                   |
| `changedFiles`  | `files: FileDiff[]`                                                                                                                     | after a step that touched files                                                                   |
| `autoApprove`   | `enabled: boolean`                                                                                                                      | per-chat auto-approval loaded / toggled                                                           |
| `focusInput`    | –                                                                                                                                       | `opencode.focus`                                                                                  |
| `notice`        | `error: UiError` (with optional `target` for a failed inline reply)                                                                     | transient error (e.g. prompt rejected)                                                            |

### Webview → host

| type                                                                                                                                              | payload                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ready`                                                                                                                                           | –                                                                                                      |
| `send`                                                                                                                                            | `text`, `attachments: Attachment[]`, `context: ContextItem[]`                                          |
| `abort`                                                                                                                                           | –                                                                                                      |
| `newSession`, `selectSession {id}`, `deleteSession {id}`, `deleteAllSessions`, `renameSession {id, title}`, `refreshSessions`, `loadMoreSessions` |                                                                                                        |
| `setModel {model}`, `setAgent {agent}`                                                                                                            |                                                                                                        |
| `setAutoApprove {enabled}`                                                                                                                        | per-chat auto-approval toggle                                                                          |
| `permissionReply {requestId, sessionId, decision: once\|always\|reject}`                                                                          |                                                                                                        |
| `formReply {formId, sessionId, answer}`, `formCancel {formId, sessionId}`                                                                         |                                                                                                        |
| `usePrompt {id}`                                                                                                                                  | insert a library prompt into the composer, with `$variables` resolved by the host                      |
| `saveInstruction {text}`                                                                                                                          | append a finished reply as a dated note to AGENTS.md (or a chosen workspace file)                      |
| `applyCode {text, path?}`                                                                                                                         | apply a reply's code block: host previews in a diff and writes only after explicit Accept              |
| `searchFiles {query}`                                                                                                                             |                                                                                                        |
| `openDiff {file, patch, applied}`, `openDiffs {files: [{file, patch}]}`, `openFile {path}`, `openLink {href}`                                     |                                                                                                        |
| `copy {text}`                                                                                                                                     | copy code block to clipboard                                                                           |
| `action {id}`                                                                                                                                     | `reconnect`, `showLogs`, `openSettings`, `install`, `login`, `setPassword`, `openFolder`, `newSession` |
| `selectFolder {uri}`                                                                                                                              | switch workspace folder                                                                                |
| `refreshChanges`                                                                                                                                  | re-fetch the session diff                                                                              |
| `dismissCompatibility {version}`                                                                                                                  | hide the version warning for this version                                                              |

The composer draft is persisted in the webview with `vscode.setState`; it is not a protocol message.

The composer splits its mention popup by trigger: `@` searches workspace files, and `/` covers skills,
prompts and commands. When a file is picked from the `@` mention results, the composer removes the
`@query` from the text and adds the file as a chip: the prompt carries the attachment through the
`attachments` field, not through an `@name` in the text.
`@skill` and `/command` selections instead keep their token in the text, which OpenCode resolves when
the prompt is sent. Tokens matching a known command or skill are underlined like links by a
transparent overlay above the textarea; unknown ones stay plain text.

`UiError = { kind, message, detail?, actions: ActionId[], target?: { kind: "permission" \| "form", id } }`, kinds:
`notInstalled`, `startFailed`, `unauthorized`, `noProvider`, `connectionLost`, `promptFailed`,
`noWorkspace`, `requestFailed`.

The `skills` catalog is fetched from `GET /api/skill` without a workspace-location override so
OpenCode includes its global skill sources. The webview receives only each skill's ID, name and
description. Selecting `/skill-id` converts it to `@skill-id` when sending, which is the syntax
OpenCode uses to load a skill; unrelated slash commands remain unchanged.

### Step folds

OpenCode emits one assistant message per step. Each step's prose stays in the conversation while its
thoughts and tool calls go into a collapsible labelled **Step N** (or **Steps N–M** when consecutive
textless steps share one fold). Prose breaks a run, so a thought emitted after a sentence stays below
it in its own fold.

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
- Managed server password: random 24 bytes per spawn, kept in memory only.
  External server password: `SecretStorage`.
- Server is bound to `127.0.0.1`.
- Permissions and questions are only auto-answered when the user explicitly opts in
  (`opencode.autoApprovePermissions` or the per-chat toggle); both default to off. Questions
  (forms) always require a user answer, even with auto-approval enabled.
