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
`GET /api/session/{id}/message` whenever the view is (re)created or the event stream reconnects,
then kept live by forwarding the session's SSE events. The webview therefore doesn't need
`retainContextWhenHidden`; only the composer draft is kept in `vscode.setState`.

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
l10n/                     runtime translations (bundle.l10n.it.json)
package.nls*.json         manifest translations
docs/                     API notes, decisions, known limits, manual test
```

## Extension ↔ webview protocol

All messages are JSON objects with a `type` discriminator, defined in `src/shared/protocol.ts`.

### Host → webview

| type | payload | when |
| --- | --- | --- |
| `init` | `strings`, `folders`, `activeFolder`, `platform` | after `ready` |
| `connection` | `status: idle\|starting\|connected\|reconnecting\|error`, `error?: UiError` | any status change |
| `catalog` | `models`, `agents`, `skills`, selected model and agent | after connect / config change |
| `sessions` | `items: SessionSummary[]`, `currentId` | list changed |
| `session` | `info`, `messages` (raw server history), `permissions`, `forms` | session loaded / resync |
| `event` | `event` (raw server SSE event for the current session) | live |
| `context` | `items: ContextItem[]` | active editor / selection changed |
| `fileResults` | `query`, `items` | answer to `searchFiles` |
| `addAttachment` | `item` | "Add selection to chat" command |
| `changedFiles` | `files: FileDiff[]` | after a step that touched files |
| `focusInput` | – | `opencode.focus` |
| `notice` | `UiError` | transient error (e.g. prompt rejected) |

### Webview → host

| type | payload |
| --- | --- |
| `ready` | – |
| `send` | `text`, `attachments: Attachment[]`, `excludedContext: string[]` |
| `abort` | – |
| `newSession`, `selectSession {id}`, `deleteSession {id}`, `refreshSessions` | |
| `setModel {providerID, id, variant?}`, `setAgent {id}` | |
| `permissionReply {requestId, sessionId, decision: once\|always\|reject}` | |
| `formReply {formId, sessionId, answer}`, `formCancel {formId, sessionId}` | |
| `searchFiles {query}` | |
| `openDiff {file, patch, applied}`, `openFile {path}` | |
| `action {id}` | `reconnect`, `showLogs`, `openSettings`, `install`, `login`, `setPassword`, `retry` |
| `selectFolder {folder}` | |
| `persistDraft` (handled in webview via setState) | |

`UiError = { kind, message, detail?, actions: {id,label}[] }`, kinds:
`notInstalled`, `startFailed`, `unauthorized`, `noProvider`, `connectionLost`, `promptFailed`,
`interrupted`, `executionFailed`.

The `skills` catalog is fetched from `GET /api/skill` without a workspace-location override so
OpenCode includes its global skill sources. The webview receives only each skill's ID, name and
description. Selecting `/skill-id` converts it to `@skill-id` when sending, which is the syntax
OpenCode uses to load a skill; unrelated slash commands remain unchanged.

## Security

* Webview CSP: `default-src 'none'; script-src 'nonce-…'; style-src ${cspSource} 'unsafe-inline';
  img-src ${cspSource} data:; font-src ${cspSource}`. No remote scripts, no `connect-src`
  (the webview never talks to the server directly).
* Markdown HTML is sanitised with DOMPurify.
* Managed server password: random 32 bytes per spawn, kept in memory only.
  External server password: `SecretStorage`.
* Server is bound to `127.0.0.1`.
* Permissions and questions are never auto-answered.
