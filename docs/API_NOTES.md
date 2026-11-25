# OpenCode server API notes

The endpoints and events below are taken from OpenCode v2.2.7 unless marked _(docs only)_, and checked against the v2.4.0 OpenAPI schema.
2.3.0 and 2.4.0 add fields, event types and experimental routes outside the surface used here, so
the shapes below are unchanged across these versions. The full OpenAPI 3.1 document for the supported 2.4.0 contract is
saved in [`openapi-2.4.0.json`](./openapi-2.4.0.json) (from `@opencode/protocol` at tag `v2.4.0`); the
previous [`openapi-2.3.0.json`](./openapi-2.3.0.json) and the original
[`openapi-2.2.7.json`](./openapi-2.2.7.json) are kept for history and the recorded fixtures.

Sources: https://opencode.ai/docs/llms.txt, https://opencode.ai/docs/api/,
https://opencode.ai/docs/cli/web/, https://opencode.ai/docs/permissions/,
https://opencode.ai/docs/attachments/, https://opencode.ai/docs/build/client/.

> OpenCode v2 is **not** compatible with the v1 API (`/session/:id/message`, `/event`, `@opencode-ai/sdk`).
> All v2 routes live under `/api/*`.

## Process

| Fact                                                                                      | How verified |
| ----------------------------------------------------------------------------------------- | ------------ |
| First stdout line: `server listening on http://127.0.0.1:60859`                           | run          |
| Without `OPENCODE_PASSWORD`, prints a second line `server password <random>`              | run          |
| `OPENCODE_PASSWORD=<pw>` env sets a fixed password (no password line printed)             | run + docs   |
| The working directory of the process becomes the default _location_ (`GET /api/location`) | run          |
| Spec at `GET /openapi.json`; HTML docs at `GET /doc`                                      | run          |

## Auth

HTTP Basic, username **always `opencode`**, password as above. Missing/invalid:
`401 {"_tag":"UnauthorizedError","message":"Authentication required"}` with
`www-authenticate: Basic realm="Secure Area"`. Bearer token is **not** accepted.

## Response envelope

Most JSON responses are `{ "data": ... }`, location-scoped ones are
`{ "location": {"directory": ...}, "data": ... }`. Errors are `{ "_tag": "<Name>Error", "message": ... }`.

## Location

Location-scoped GETs take a deepObject query: `?location[directory]=/abs/path`.
Omitted → the server's cwd. Sessions carry their own `location` (set at creation).

## Endpoints used by the extension

| Purpose             | Request                                                                                                   | Response (verified shape)                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health / info       | `GET /api/info`                                                                                           | `{version,pid,hostname,urls[],paths,capabilities}` (no envelope)                                                                                                              |
| List sessions       | `GET /api/session?directory=<abs>&limit=50&order=desc&parentID=null`                                      | `{data: Session.Info[], cursor}`                                                                                                                                              |
| Create session      | `POST /api/session` `{agent?, model?: {id,providerID,variant?}, location?: {directory}, permissions?}`    | `{data: Session.Info}`                                                                                                                                                        |
| Get session         | `GET /api/session/{id}`                                                                                   | `{data: Session.Info}` (has `title` once generated)                                                                                                                           |
| Delete session      | `DELETE /api/session/{id}`                                                                                | 204                                                                                                                                                                           |
| Rename              | `PATCH /api/session/{id}` `{title}`                                                                       |                                                                                                                                                                               |
| Messages            | `GET /api/session/{id}/message?order=asc&limit=N&cursor=`                                                 | `{data: Message[], cursor:{previous,next}}` — default order is **desc**                                                                                                       |
| Prompt              | `POST /api/session/{id}/prompt` `{text, files?: [{uri,name?,description?}], delivery?: "steer"\|"queue"}` | `{data: {id: msg_…, type:"user", payload, delivery}}` — returns immediately, output arrives via SSE                                                                           |
| Interrupt           | `POST /api/session/{id}/interrupt`                                                                        | `{interrupted: true}`                                                                                                                                                         |
| Compact             | `POST /api/session/{id}/compact` `{id?, delivery?}`                                                       | `{data: Session.Inbox.Compaction}` — steered at the next step boundary (schema only, 2.2.7)                                                                                   |
| Wait idle           | `POST /api/experimental/session/{id}/wait`                                                                | 204; a staged revert is rejected while the agent loop runs                                                                                                                    |
| Stage revert        | `POST /api/session/{id}/revert/stage` `{messageID, files?}`                                               | `{data: Session.Revert}` — restores files changed _after_ that message unless `files:false`; 409 while busy                                                                   |
| Commit revert       | `POST /api/session/{id}/revert/commit`                                                                    | 204; deletes the boundary message **and every later one** (also triggered by the next prompt/compact)                                                                         |
| Clear revert        | `DELETE /api/session/{id}/revert`                                                                         | 204; discards the staged boundary and puts its files back                                                                                                                     |
| Switch agent        | `POST /api/session/{id}/agent` `{agent}`                                                                  |                                                                                                                                                                               |
| Switch model        | `POST /api/session/{id}/model` `{model:{id,providerID,variant?}}`                                         |                                                                                                                                                                               |
| Pending permissions | `GET /api/session/{id}/permission`                                                                        | `{data: PermissionRequest[]}`                                                                                                                                                 |
| Reply permission    | `POST /api/session/{id}/permission/{perID}/reply` `{decision: "once"\|"always"\|"reject", message?}`      | 204                                                                                                                                                                           |
| Pending forms       | `GET /api/session/{id}/form`                                                                              | `{data: Form[]}`                                                                                                                                                              |
| Reply form          | `POST /api/session/{id}/form/{frmID}/reply` `{answer: Record<key, string\|number\|boolean\|string[]>}`    | 204                                                                                                                                                                           |
| Cancel form         | `DELETE /api/session/{id}/form/{frmID}`                                                                   | _(schema only)_                                                                                                                                                               |
| Session diff        | `GET /api/session/{id}/diff`                                                                              | `{data: [{file, patch, additions, deletions, status: added\|deleted\|modified}]}` — empty when not a git repo                                                                 |
| Models              | `GET /api/model?types=chat`                                                                               | `{data: Model[]}`; Model has `id, modelID, providerID, name, enabled, variants[{id}]`                                                                                         |
| Default model       | `GET /api/model/default`                                                                                  | `{data: Model \| null}`                                                                                                                                                       |
| Agents              | `GET /api/agent`                                                                                          | `{data: [{id,name,description?,mode: primary\|subagent\|all, hidden}]}`; seen: build, plan (primary, visible), general, explore (subagent), compaction/title/summary (hidden) |
| Skills              | `GET /api/skill`                                                                                          | `{location, data: [{id,name,description?,autoinvoke?,path,content}]}`; uses the server's default location and includes global skill sources                                   |
| Commands            | `GET /api/command`                                                                                        | `{location, data: [{name,description?}]}` (2.2.7: `init`, `review`, `goal`)                                                                                                   |
| Run command         | `POST /api/session/{id}/command` `{name,text,files?,...}`                                                 | 204; `text` is the argument string after the command name                                                                                                                     |

> Both catalogs are **empty until a session exists**: plugin-provided skills and commands are
> registered when a session is created (verified 2.2.7: 0 → 25 skills / 0 → 3 commands on the same
> server after `POST /api/session`). Refetch after creating/loading a session and republish.
> | Providers | `GET /api/provider` | `{data: [{id, name, activation}]}` |
> | File search | `GET /api/fs/find?query=<q>&type=file&limit=N` | `{data:[{path (relative), type}]}` |
> | Events | `GET /api/event` | SSE, see below |

## Attachments _(docs + prompt shape verified)_

`files[].uri` is an absolute `file://` URL; text ranges via `?start=<1-based>&end=<1-based>`.
`data:` URLs also allowed. HTTP(S) not supported. The server resolves `file://` URIs against **its
own** filesystem (`stat`/`readFile`; missing paths fail with `Unable to read attachment: <uri>`,
20 MiB limit), so the client must send `data:` URLs for files the server cannot see — e.g. files
outside the workspace, or any local file when the server runs elsewhere (`opencode.endpoint`).

## SSE `/api/event`

- Only `data: <json>` lines (no `event:` field), blank line separator.
- Keep-alive comment lines `: heartbeat`.
- First event: `{"id":"evt_…","type":"server.connected","data":{}}`.
- Global stream (all locations). Each event: `{id, created, type, location?, data, durable?}`.
- Live only, no replay → on reconnect, refetch state.

### Event sequence for one prompt (verified)

```
session.inbox.enqueued     {sessionID, inboxID, item:{type:"user", payload:{text}}}
session.execution.started  {sessionID}
session.inbox.delivered    {sessionID, inboxID}
session.step.started       {sessionID, assistantMessageID, agent, model}
session.reasoning.started  {…, assistantMessageID, ordinal}
session.reasoning.delta    {…, ordinal, delta}
session.text.started       {…, ordinal}              <- may interleave with reasoning.ended
session.reasoning.ended    {…, ordinal, text}
session.text.delta         {…, ordinal, delta}
session.text.ended         {…, ordinal, text}
session.tool.input.started {…, id, name}
session.tool.input.delta   {…, id, delta}
session.tool.input.ended   {…, id, text}
session.tool.called        {…, id, input}
session.tool.progress      {…, id, metadata}
session.tool.success       {…, id, content:[{type:"text",text}|{type:"file",uri,mime}], metadata}
session.tool.failed        {…, id, error:{type,message}}
session.step.ended         {…, finish, tokens, cost, snapshot?, files?[]}
session.step.failed        {…, error:{type:"aborted",message:"Step interrupted"}}
session.usage.updated      {sessionID, cost, tokens}
session.execution.succeeded|failed {error}|interrupted {reason:"user"|…}
session.renamed            {sessionID, title}        <- auto title, after first turn
session.status             {sessionID, status:{type:"idle"|"busy"|"retry",…}}  (schema)
permission.asked           {id, sessionID, action, resources[], save?[], metadata?, source?:{type:"tool",messageID,id}}
permission.replied         {sessionID, requestID, reply}
form.created               {form:{id, sessionID, title, metadata?, fields: Form.Field[]}}
form.replied / form.cancelled {id, sessionID}
```

`ordinal` counters are **per kind** (text 0 and reasoning 0 can coexist in one message).

### Subagents (verified 2.2.7)

A primary agent launches a subagent with the `subagent` tool. The whole exchange is visible on the
**same global SSE stream**, but the child's events carry the child's `sessionID`:

```
session.tool.input.started  {sessionID: <parent>, id, name: "subagent"}
session.tool.input.ended    {…, text: '{"agent":"explore","description":"…","prompt":"…"}'}  <- input may be a JSON string
session.tool.called         {…, id, input: <JSON string>}
session.created             {sessionID: <child>, parentID: <parent>, title, agent, model}    <- link
session.tool.progress       {sessionID: <parent>, id, metadata: {sessionID: <child>, status: "running"}}
... child session events ... (step/tool/text/reasoning/usage/execution.* with sessionID: <child>)
session.tool.success        {sessionID: <parent>, id,
                             content:[{type:"text",text:"<subagent sessionID=… state=\"completed\">…</subagent>"}],
                             metadata:{sessionID: <child>, status:"completed", truncated:false}}
```

The child session is hidden from `GET /api/session?parentID=null`, and every child event is dropped
by a consumer that only forwards the selected `sessionID`. The extension follows children from
`session.created.parentID` and from `session.tool.progress.metadata.sessionID`, fetches each child's
history once (`GET /api/session/{child}/message`, `…/permission`, `…/form`) and renders its progress
inside the subagent tool card. `GET /api/experimental/job?sessionID=<parent>&kind=subagent&descendants=true`
also lists `Job.Subagent` records (`childSessionID`, `agent`, `description`, `status`, `time`), but no
`job.*` SSE event exists, so the live stream of the child session is the only source of live progress.

**Background subagents** (`"background": true` in the tool input) behave differently: the parent's
`session.tool.success` arrives immediately with `metadata.status: "running"` and text saying the
child works in the background; the child keeps emitting events after the parent turn ended, and its
final answer is delivered to the parent as a synthetic inbox item:

```
session.inbox.enqueued {item:{type:"synthetic",
  payload:{text:"<subagent sessionID=\"ses_…\" state=\"completed\" description=\"…\">REPORT</subagent>"}}}
session.execution.started  {sessionID: <parent>}   <- parent wakes up to consume the report
```

The extension parses that wrapper so the report is shown in the tool card even if no child event
was captured, and re-fetches the child's history at that point to fill in its steps.

The webview keeps a `ChatState` per child, built with the **same reducer as the main chat**, so the
inline card can show a compact timeline and the **Open subagent conversation** action can promote
that state to a read-only modal using the normal conversation renderer. Nested children are linked
by `session.created.parentID`, which lets the modal offer breadcrumbs back to the parent. A child
whose live state is missing (a past session, or a background child that finished while the webview
was detached) is re-fetched on demand with `refreshSubagent`, using the same endpoint as the initial
snapshot. No new host events are needed to open the modal.

`permission.asked` and `form.created` for a child arrive on the same stream with the child's
`sessionID` and are stored in its `ChatState` like the main chat's. A subagent has no composer, so
the host collects pending requests from **all tracked children** into the parent chat's attention
overlay, labelled with the child's title or agent. `PermissionCard` / `QuestionCard` reply with
`request.sessionID` / `form.sessionID`, so `POST /api/session/{child}/permission/{id}/reply` (or the
form equivalent) reaches the child and the turn resumes — the same protocol, addressed to another
session. The modal docks a second overlay because its backdrop hides the chat's one; the main overlay
drops child requests while the modal is open to avoid duplicate cards and DOM ids. With auto-approve
on, requests for tracked children are granted on arrival with `replyPermission(..., "once")`, the
already-pending ones are swept when the toggle is turned on, and stale requests in a fresh child
snapshot are filtered the same way. The inline subagent card switches to an amber `waiting` dot plus
a _Needs your input_ badge while a child is blocked, but never renders a second actionable card.

### Message history shape (`GET …/message`)

```
{type:"user", id, text, files?, time}
{type:"assistant", id, agent, model, content:[
   {type:"text", text} |
   {type:"reasoning", text, time} |
   {type:"tool", id, name, state:{status:"streaming",input:string}|{status:"running",input,metadata}|
                                {status:"completed",input,content,metadata?}|{status:"error",input,error}}
 ], finish?, error?, tokens?, cost?, time:{created,completed?}}
{type:"idle", outcome:"succeeded"|"failed"|"interrupted", error?}
{type:"synthetic"|"system"|"skill"|"shell"|"agent-switched"|"model-switched"|"compaction"|…}
```

## Permissions

Default config auto-allows edits/shell in a git project (no `permission.asked` was emitted for
`write`/`shell` with default rules). Rule `{action:"edit",resource:"*",effect:"ask"}` passed at
session creation produced:

```json
{
  "id": "per_…",
  "sessionID": "ses_…",
  "action": "edit",
  "resources": ["a.txt"],
  "save": ["*"],
  "metadata": { "files": [{ "file": "a.txt", "patch": "Index: a.txt\n…", "status": "modified", "additions": 1, "deletions": 1 }] },
  "source": { "type": "tool", "messageID": "msg_…", "id": "chatcmpl-tool-…" }
}
```

Replying `once` → `permission.replied`, the tool then completes. Edit tool results carry
`metadata.files[]` with the same `{file, patch, status}` shape.

## Questions

The `question` tool creates a **form**: `form.created` with
`metadata.kind:"question"` and fields like
`{key:"q0", title, description, type:"string", options:[{value,label,description}], custom:true}`.
Reply `{answer:{q0:"Blue"}}` → `form.replied` + `session.tool.success`.

## Todo list

There is no todo endpoint or event. The only mention in the spec is the config flag
`experimental.todo: boolean`. With `{"experimental":{"todo":true}}` in `opencode.json`, the agent
gets a **`todowrite`** tool (verified):

```json
session.tool.called  {"id":"chatcmpl-tool-…","input":{"todos":[{"content":"First task","status":"in_progress"},{"content":"Second task","status":"pending"}]}}
session.tool.success {"content":[{"type":"text","text":"Todos updated: 0/3 completed, …"}],"metadata":{"todos":[…same…]}}
```

The extension derives the todo panel from the latest `todowrite` call in the session
(status values seen: `pending`, `in_progress`; `completed` assumed from the summary text).

- The real server rejects `order` combined with `cursor` on `GET …/message` (400 "Cursor cannot be combined with order"); only send `order` on the first page. Found by the e2e test.

## Context window and usage (verified 2.2.7)

- `GET /api/model` items carry `limit: {context, input?, output}` (present on all 78 models seen).
- No endpoint reports the context size in tokens (`GET /session/{id}/context` returns messages).
  Usage is derived from the last step's `tokens` (`session.step.ended` or `assistant.tokens` in
  history). `input` **excludes** cached tokens: step 1 `input 6943 + cache.read 1536 = 8479`,
  step 2 `input 324 + cache.read 8192 = 8516` (same prompt plus the new message). The extension uses
  `input + cache.read + cache.write + output + reasoning`.
