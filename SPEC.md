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
│                                    (generated from docs/openapi-2.2.7.json)   │
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

Raw server payloads are normalised by `src/shared/adapter.ts` before reaching the reducer. The raw
wire shapes for the 2.2.7 snapshot are generated from `docs/openapi-2.2.7.json` by
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
l10n/                     runtime translation bundles (English source strings by default)
package.nls.json          manifest strings (English)
docs/                     API notes, decisions, known limits, manual test
```

## Extension ↔ webview protocol

All messages are JSON objects with a `type` discriminator, defined in `src/shared/protocol.ts`.

### Host → webview

| type | payload | when |
| --- | --- | --- |
| `init` | `strings`, `platform`, `folders`, `activeFolder?`, `issuesUrl?` | after `ready` |
| `connection` | `status: idle\|starting\|connected\|reconnecting\|error`, `error?`, `version?`, `compatibility?`, `compatibilityDismissed?` | any status change |
| `catalog` | `models`, `agents`, `skills`, `selectedModel?`, `selectedAgent?` | after connect / config change |
| `sessions` | `items: SessionSummary[]`, `currentId?`, `hasMore?` | list changed / more pages loaded |
| `session` | `session: SessionPayload \| null` (`id`, `title?`, `agent?`, `model?`, `busy`, normalised `messages`, `permissions`, `forms`, `usage?`) | session loaded / full resync |
| `sessionDelta` | `delta: SessionDelta` (tail `messages` + updated pending items/usage) | reconnect/reconcile found no or few new messages; merged by id, does not reset conversation state |
| `event` | `event` (raw server SSE event for the current session) | live |
| `context` | `items: ContextItem[]` | active editor / selection changed |
| `fileResults` | `query`, `items` | answer to `searchFiles` |
| `addAttachment` | `item` | "Add selection to chat" command |
| `changedFiles` | `files: FileDiff[]` | after a step that touched files |
| `autoApprove` | `enabled: boolean` | per-chat auto-approval loaded / toggled |
| `focusInput` | – | `opencode.focus` |
| `notice` | `error: UiError` (with optional `target` for a failed inline reply) | transient error (e.g. prompt rejected) |

### Webview → host

| type | payload |
| --- | --- |
| `ready` | – |
| `send` | `text`, `attachments: Attachment[]`, `context: ContextItem[]` |
| `abort` | – |
| `newSession`, `selectSession {id}`, `deleteSession {id}`, `renameSession {id, title}`, `refreshSessions`, `loadMoreSessions` | |
| `setModel {model}`, `setAgent {agent}` | |
| `setAutoApprove {enabled}` | per-chat auto-approval toggle |
| `permissionReply {requestId, sessionId, decision: once\|always\|reject}` | |
| `formReply {formId, sessionId, answer}`, `formCancel {formId, sessionId}` | |
| `searchFiles {query}` | |
| `openDiff {file, patch, applied}`, `openFile {path}`, `openLink {href}` | |
| `copy {text}` | copy code block to clipboard |
| `action {id}` | `reconnect`, `showLogs`, `openSettings`, `install`, `login`, `setPassword`, `openFolder`, `newSession` |
| `selectFolder {uri}` | switch workspace folder |
| `refreshChanges` | re-fetch the session diff |
| `dismissCompatibility {version}` | hide the version warning for this version |

The composer draft is persisted in the webview with `vscode.setState`; it is not a protocol message.

`UiError = { kind, message, detail?, actions: ActionId[], target?: { kind: "permission" \| "form", id } }`, kinds:
`notInstalled`, `startFailed`, `unauthorized`, `noProvider`, `connectionLost`, `promptFailed`,
`noWorkspace`, `requestFailed`.

The `skills` catalog is fetched from `GET /api/skill` without a workspace-location override so
OpenCode includes its global skill sources. The webview receives only each skill's ID, name and
description. Selecting `/skill-id` converts it to `@skill-id` when sending, which is the syntax
OpenCode uses to load a skill; unrelated slash commands remain unchanged.

### Changed files and cost

`changedFiles` normally comes from `GET /session/{id}/diff`, but that endpoint is empty outside git
repositories. The webview therefore merges it with patches from completed tool calls
(`metadata.files`, via `selectToolChangedFiles`); the server diff wins for the same path. The
`session.usage.updated` event's cost is kept in `ChatState.usage` and shown in the composer's
context meter. Changing session (new/folder switch/select/delete) clears conversation-scoped webview
state — drafts, staged attachments and the changed-files panel — while a same-session resync keeps it.

## Security

* Webview CSP: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource};
  img-src ${cspSource} data:; font-src ${cspSource}`. No remote scripts, no `connect-src`
  (the webview never talks to the server directly).
* Markdown HTML is sanitised with DOMPurify.
* Managed server password: random 32 bytes per spawn, kept in memory only.
  External server password: `SecretStorage`.
* Server is bound to `127.0.0.1`.
* Permissions and questions are never auto-answered.
