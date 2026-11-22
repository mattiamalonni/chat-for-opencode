/**
 * Recorded demo conversation used by the webview's "Play demo conversation" action.
 *
 * Provenance: the first turn of `test/fixtures/real-sse3.jsonl` (real OpenCode 2.2.7 events,
 * events 17-53), with the session id replaced by a fixed demo id and the transport-only
 * `durable` / `metadata` / `location` fields removed. It is data only: the reducer folds these
 * events exactly as it folds live SSE, so no host code or server is involved. To refresh it, slice
 * the fixture again and rewrite its `sessionID` to `DEMO_SESSION_ID`.
 */
import type { ServerEvent } from "./api";
import type { SessionPayload } from "./protocol";

export const DEMO_SESSION_ID = "ses_demo0000000000000000001";

export const DEMO_SESSION: SessionPayload = {
  id: DEMO_SESSION_ID,
  title: "Demo — fix a small bug",
  agent: "build",
  model: { id: "hy4-flash-free", providerID: "opencode" },
  busy: false,
  messages: [],
  permissions: [],
  forms: [],
};

/** Real recorded events, replayed in order with `demoEventDelay` pacing. */
// prettier-ignore
export const DEMO_EVENTS: ServerEvent[] = [
  {"id":"evt_1e59397420011rzaytSXEIKnWv","created":1794853017410,"type":"session.inbox.enqueued","data":{"inboxID":"msg_1e593965f001fM4b0MRqaI2RsV","sessionID":"ses_demo0000000000000000001","item":{"type":"user","payload":{"text":"Edit a.txt so its content becomes b instead of a. Use the edit or write tool."},"delivery":"steer"}}},
  {"id":"evt_1e5939744001VQvLfRDbw1kGTQ","created":1794853017412,"type":"session.execution.started","data":{"sessionID":"ses_demo0000000000000000001"}},
  {"id":"evt_1e5939830001supqYvTcHWiDrn","created":1794853017648,"type":"mcp.status.changed","data":{"server":"postman"}},
  {"id":"evt_1e5939837001t4Rm2fxHChEDH3","created":1794853017655,"type":"session.instructions.updated","data":{"sessionID":"ses_demo0000000000000000001","delta":{"core/codemode":"b9321aa27fe3f9eb6662ad886008492dd401333a0049c044c54ac2323b9ead1e","core/skill-guidance":"ed5bb4a167a689314779e04712860b671ec8459dc15724a28df49956338bd3b7","core/date":"7eb731901e8910ce17e619c470f2b871d07f07839ed22243e33e1ae416bf40aa","core/environment":"f3f8dcfaaf86b277c739dcddbbf8de11d3e28eb70ec87459f6af59fc4d9e15e0"}}},
  {"id":"evt_1e5939839001y5SIeg9MxuaUrK","created":1794853017657,"type":"session.inbox.delivered","data":{"sessionID":"ses_demo0000000000000000001","inboxID":"msg_1e593965f001fM4b0MRqaI2RsV"}},
  {"id":"evt_1e5939ee3001h1PljNYr24RRWj","created":1794853019363,"type":"session.step.started","data":{"sessionID":"ses_demo0000000000000000001","agent":"build","model":{"id":"hy4-flash-free","providerID":"opencode","variant":"default"},"assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","snapshot":"08585692ce06452da6f82ae66b90d98b55536fca","started":1794853017676}},
  {"id":"evt_1e5939ee7001QzHKSEiE1oBc3Q","created":1794853019367,"type":"session.reasoning.started","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","ordinal":0,"native":{"reasoningField":"reasoning"}}},
  {"id":"evt_1e5939f4e001Ui2AXQ36iKCJaf","created":1794853019470,"type":"session.reasoning.delta","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","ordinal":0,"delta":"The user"}},
  {"id":"evt_1e5939fb0001vrvo6Pg7uDP7k6","created":1794853019568,"type":"session.reasoning.delta","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","ordinal":0,"delta":" wants me to edit a.txt so its content becomes \"b\" instead of \"a\". Let me look at the file first."}},
  {"id":"evt_1e5939fb000236ft3ozDAPmNQd","created":1794853019568,"type":"session.tool.input.started","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","id":"chatcmpl-tool-bd7b381c89c07f0f","name":"read"}},
  {"id":"evt_1e5939fbe001h8zNiTMRRAfv5K","created":1794853019582,"type":"session.reasoning.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","ordinal":0,"text":"The user wants me to edit a.txt so its content becomes \"b\" instead of \"a\". Let me look at the file first.","native":{"reasoningField":"reasoning","reasoningDetails":[{"type":"reasoning.text","text":"The user wants me to edit a.txt so its content becomes \"b\" instead of \"a\". Let me look at the file first.","format":"unknown","index":0}]}}},
  {"id":"evt_1e5939fc50019AxMpvxJ7IJH93","created":1794853019589,"type":"session.tool.input.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","id":"chatcmpl-tool-bd7b381c89c07f0f","text":"{\"path\": \"a.txt\"}"}},
  {"id":"evt_1e5939fc7001guzmvqJ8W60vcZ","created":1794853019591,"type":"session.tool.called","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","id":"chatcmpl-tool-bd7b381c89c07f0f","input":{"path":"a.txt"},"executed":false}},
  {"id":"evt_1e5939fc90016pSoirzExucKw0","created":1794853019593,"type":"session.step.streamed","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42"}},
  {"id":"evt_1e5939fd0001k7npqaTfGwicQJ","created":1794853019600,"type":"session.tool.success","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","id":"chatcmpl-tool-bd7b381c89c07f0f","content":[{"type":"text","text":"Read file a.txt, lines 1-1\n1: a"}],"metadata":{"truncated":false},"executed":false}},
  {"id":"evt_1e5939fe4001ZCeYCxRFKqps6G","created":1794853019620,"type":"session.step.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939845001dhz4GYroIJ2t42","finish":"tool-calls","rawFinish":"tool_calls","tokens":{"input":6637,"output":14,"reasoning":28,"cache":{"read":1792,"write":0}},"cost":0,"snapshot":"08585692ce06452da6f82ae66b90d98b55536fca","files":[]}},
  {"id":"evt_1e5939fe6001AkkoSDTzxSOuae","created":1794853019622,"type":"session.usage.updated","data":{"sessionID":"ses_demo0000000000000000001","cost":0,"tokens":{"input":6637,"output":14,"reasoning":28,"cache":{"read":1792,"write":0}}}},
  {"id":"evt_1e593a20c001MWKIAno6I0r94U","created":1794853020172,"type":"session.usage.updated","data":{"sessionID":"ses_demo0000000000000000001","cost":0,"tokens":{"input":6854,"output":22,"reasoning":263,"cache":{"read":2048,"write":0}}}},
  {"id":"evt_1e593a20d00170dU3Nnm54eSfo","created":1794853020173,"type":"session.renamed","data":{"sessionID":"ses_demo0000000000000000001","title":"Change a.txt content to b"}},
  {"id":"evt_1e593a611001kEk1wzH2t8INzF","created":1794853021201,"type":"session.step.started","data":{"sessionID":"ses_demo0000000000000000001","agent":"build","model":{"id":"hy4-flash-free","providerID":"opencode","variant":"default"},"assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","snapshot":"08585692ce06452da6f82ae66b90d98b55536fca","started":1794853019628}},
  {"id":"evt_1e593a614001Pa4u0zWqjtPOuM","created":1794853021204,"type":"session.tool.input.started","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","id":"chatcmpl-tool-8dacb69b1aba1eab","name":"edit"}},
  {"id":"evt_1e593a66e001s6RtYxzJnMEmri","created":1794853021294,"type":"session.tool.input.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","id":"chatcmpl-tool-8dacb69b1aba1eab","text":"{\"path\": \"a.txt\", \"oldString\": \"a\", \"newString\": \"b\"}"}},
  {"id":"evt_1e593a671001j8Ccej3jlUn7jZ","created":1794853021297,"type":"session.tool.called","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","id":"chatcmpl-tool-8dacb69b1aba1eab","input":{"path":"a.txt","oldString":"a","newString":"b"},"executed":false}},
  {"id":"evt_1e593a673001utHrTbbN3e3LBp","created":1794853021299,"type":"session.step.streamed","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp"}},
  {"id":"evt_1e593a679002HQL61t67hhQjHd","created":1794853021305,"type":"permission.asked","data":{"id":"per_1e593a679001fhKAtheTHEtX2f","sessionID":"ses_demo0000000000000000001","action":"edit","resources":["a.txt"],"save":["*"],"metadata":{"files":[{"file":"a.txt","patch":"Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n","status":"modified","additions":1,"deletions":1}]},"source":{"type":"tool","messageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","id":"chatcmpl-tool-8dacb69b1aba1eab"}}},
  {"id":"evt_1e593c594001UjHaLIkH3fZ65D","created":1794853029268,"type":"permission.replied","data":{"sessionID":"ses_demo0000000000000000001","requestID":"per_1e593a679001fhKAtheTHEtX2f","reply":"once"}},
  {"id":"evt_1e593c596001VUS0wryMjs53G3","created":1794853029270,"type":"session.tool.success","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","id":"chatcmpl-tool-8dacb69b1aba1eab","content":[{"type":"text","text":"Edited a.txt (1 replacement)"}],"metadata":{"files":[{"file":"a.txt","patch":"Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n","status":"modified","additions":1,"deletions":1}],"truncated":false},"executed":false}},
  {"id":"evt_1e593c5c2001f2qJ59krXUvhKb","created":1794853029314,"type":"session.step.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e5939fe9001kJBYoRwCHFEDXp","finish":"tool-calls","rawFinish":"tool_calls","tokens":{"input":304,"output":28,"reasoning":0,"cache":{"read":8192,"write":0}},"cost":0,"snapshot":"437653189f71585c4c625ebb302bcff1c949cd3d","files":["a.txt"]}},
  {"id":"evt_1e593c5c4001QSMCCB0xDBi1mH","created":1794853029316,"type":"session.usage.updated","data":{"sessionID":"ses_demo0000000000000000001","cost":0,"tokens":{"input":7158,"output":50,"reasoning":263,"cache":{"read":10240,"write":0}}}},
  {"id":"evt_1e593cc48001MMMGHHF46Bi35N","created":1794853030984,"type":"session.step.started","data":{"sessionID":"ses_demo0000000000000000001","agent":"build","model":{"id":"hy4-flash-free","providerID":"opencode","variant":"default"},"assistantMessageID":"msg_1e593c5c7001uiO7LlIGNYEVMw","snapshot":"437653189f71585c4c625ebb302bcff1c949cd3d","started":1794853029321}},
  {"id":"evt_1e593cc4c001TeK2RcmmMAN6Tk","created":1794853030988,"type":"session.text.started","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e593c5c7001uiO7LlIGNYEVMw","ordinal":0}},
  {"id":"evt_1e593cc4f00102X2WYkDfP6K1W","created":1794853030991,"type":"session.text.delta","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e593c5c7001uiO7LlIGNYEVMw","ordinal":0,"delta":"Done — `a.txt` now contains `b` instead of `a`."}},
  {"id":"evt_1e593cc4f002OT0eh1cWcLL3fm","created":1794853030991,"type":"session.text.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e593c5c7001uiO7LlIGNYEVMw","ordinal":0,"text":"Done — `a.txt` now contains `b` instead of `a`."}},
  {"id":"evt_1e593cc51001EKMZyoriLhju9m","created":1794853030993,"type":"session.step.streamed","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e593c5c7001uiO7LlIGNYEVMw"}},
  {"id":"evt_1e593cc62001uaXxRnxZrk4SWV","created":1794853031010,"type":"session.step.ended","data":{"sessionID":"ses_demo0000000000000000001","assistantMessageID":"msg_1e593c5c7001uiO7LlIGNYEVMw","finish":"stop","rawFinish":"stop","tokens":{"input":94,"output":18,"reasoning":0,"cache":{"read":8448,"write":0}},"cost":0,"snapshot":"437653189f71585c4c625ebb302bcff1c949cd3d","files":[]}},
  {"id":"evt_1e593cc64001dHcSFLUxaMW8v1","created":1794853031012,"type":"session.usage.updated","data":{"sessionID":"ses_demo0000000000000000001","cost":0,"tokens":{"input":7252,"output":68,"reasoning":263,"cache":{"read":18688,"write":0}}}},
  {"id":"evt_1e593cc65001t6xpa3CLv31HIL","created":1794853031013,"type":"session.execution.succeeded","data":{"sessionID":"ses_demo0000000000000000001"}},
];

/**
 * Streaming-style pacing: text and reasoning land quickly, structural events pause briefly so the
 * tool cards and the approval card are readable. Pure and deterministic for unit tests.
 */
export function demoEventDelay(event: ServerEvent): number {
  const type = event.type ?? "";
  return type.endsWith(".delta") ? 70 : 220;
}
