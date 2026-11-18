# OpenCode server API notes

Everything here was **verified against a running `opencode serve` v2.2.7** (macOS, 2026-11-16)
unless marked _(docs only)_. The full OpenAPI 3.1 document served by that build is saved in
[`openapi-2.2.7.json`](./openapi-2.2.7.json) (fetched from `GET /openapi.json`).

Sources: https://opencode.ai/docs/llms.txt, https://opencode.ai/docs/api/,
https://opencode.ai/docs/cli/web/, https://opencode.ai/docs/permissions/,
https://opencode.ai/docs/attachments/, https://opencode.ai/docs/build/client/.

> OpenCode v2 is **not** compatible with the v1 API (`/session/:id/message`, `/event`, `@opencode-ai/sdk`).
> All v2 routes live under `/api/*`.

## Process

| Fact | How verified |
| --- | --- |
| `opencode serve --hostname 127.0.0.1 --port 0` picks a free port | run |
| First stdout line: `server listening on http://127.0.0.1:60859` | run |
| Without `OPENCODE_PASSWORD`, prints a second line `server password <random>` | run |
| `OPENCODE_PASSWORD=<pw>` env sets a fixed password (no password line printed) | run + docs |
| The working directory of the process becomes the default *location* (`GET /api/location`) | run |
| Spec at `GET /openapi.json`; HTML docs at `GET /doc` | run |

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

| Purpose | Request | Response (verified shape) |
| --- | --- | --- |
| Health / info | `GET /api/info` | `{version,pid,hostname,urls[],paths,capabilities}` (no envelope) |
| List sessions | `GET /api/session?directory=<abs>&limit=50&order=desc&parentID=null` | `{data: Session.Info[], cursor}` |
| Create session | `POST /api/session` `{agent?, model?: {id,providerID,variant?}, location?: {directory}, permissions?}` | `{data: Session.Info}` |
| Get session | `GET /api/session/{id}` | `{data: Session.Info}` (has `title` once generated) |
| Delete session | `DELETE /api/session/{id}` | 204 |
| Rename | `PATCH /api/session/{id}` `{title}` | |
| Messages | `GET /api/session/{id}/message?order=asc&limit=N&cursor=` | `{data: Message[], cursor:{previous,next}}` — default order is **desc** |
| Prompt | `POST /api/session/{id}/prompt` `{text, files?: [{uri,name?,description?}], delivery?: "steer"\|"queue"}` | `{data: {id: msg_…, type:"user", payload, delivery}}` — returns immediately, output arrives via SSE |
| Interrupt | `POST /api/session/{id}/interrupt` | `{interrupted: true}` |
| Compact | `POST /api/session/{id}/compact` `{id?, delivery?}` | `{data: Session.Inbox.Compaction}` — steered at the next step boundary (schema only, 2.2.7) |
| Switch agent | `POST /api/session/{id}/agent` `{agent}` | |
| Switch model | `POST /api/session/{id}/model` `{model:{id,providerID,variant?}}` | |
| Pending permissions | `GET /api/session/{id}/permission` | `{data: PermissionRequest[]}` |
| Reply permission | `POST /api/session/{id}/permission/{perID}/reply` `{decision: "once"\|"always"\|"reject", message?}` | 204 |
| Pending forms | `GET /api/session/{id}/form` | `{data: Form[]}` |
| Reply form | `POST /api/session/{id}/form/{frmID}/reply` `{answer: Record<key, string\|number\|boolean\|string[]>}` | 204 |
| Cancel form | `DELETE /api/session/{id}/form/{frmID}` | _(schema only)_ |
| Session diff | `GET /api/session/{id}/diff` | `{data: [{file, patch, additions, deletions, status: added\|deleted\|modified}]}` — empty when not a git repo |
| Models | `GET /api/model?types=chat` | `{data: Model[]}`; Model has `id, modelID, providerID, name, enabled, variants[{id}]` |
| Default model | `GET /api/model/default` | `{data: Model \| null}` |
| Agents | `GET /api/agent` | `{data: [{id,name,description?,mode: primary\|subagent\|all, hidden}]}`; seen: build, plan (primary, visible), general, explore (subagent), compaction/title/summary (hidden) |
| Skills | `GET /api/skill` | `{location, data: [{id,name,description?,autoinvoke?,path,content}]}`; uses the server's default location and includes global skill sources |
| Commands | `GET /api/command` | `{location, data: [{name,description?}]}` (2.2.7: `init`, `review`, `goal`) |
| Run command | `POST /api/session/{id}/command` `{name,text,files?,...}` | 204; `text` is the argument string after the command name |

> Both catalogs are **empty until a session exists**: plugin-provided skills and commands are
> registered when a session is created (verified 2.2.7: 0 → 25 skills / 0 → 3 commands on the same
> server after `POST /api/session`). Refetch after creating/loading a session and republish.
| Providers | `GET /api/provider` | `{data: [{id, name, activation}]}` |
| File search | `GET /api/fs/find?query=<q>&type=file&limit=N` | `{data:[{path (relative), type}]}` |
| Events | `GET /api/event` | SSE, see below |

## Attachments _(docs + prompt shape verified)_

`files[].uri` is an absolute `file://` URL; text ranges via `?start=<1-based>&end=<1-based>`.
`data:` URLs also allowed. HTTP(S) not supported.

## SSE `/api/event`

* Only `data: <json>` lines (no `event:` field), blank line separator.
* Keep-alive comment lines `: heartbeat`.
* First event: `{"id":"evt_…","type":"server.connected","data":{}}`.
* Global stream (all locations). Each event: `{id, created, type, location?, data, durable?}`.
* Live only, no replay → on reconnect, refetch state.

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
{"id":"per_…","sessionID":"ses_…","action":"edit","resources":["a.txt"],"save":["*"],
 "metadata":{"files":[{"file":"a.txt","patch":"Index: a.txt\n…","status":"modified","additions":1,"deletions":1}]},
 "source":{"type":"tool","messageID":"msg_…","id":"chatcmpl-tool-…"}}
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
