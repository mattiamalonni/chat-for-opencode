/* Mock OpenCode v2 server for tests. Mirrors the shapes recorded in docs/API_NOTES.md.
 *
 * Library:  const mock = await startMockServer({ password: "pw" })
 * CLI:      node test/mock/mockServer.ts serve --hostname 127.0.0.1 --port 0
 *           (prints "server listening on http://…" like `opencode serve`)
 *
 * Prompt text drives scenarios: [permission] [question] [error] [slow] [drop] [todo] [crash].
 * Only erasable TypeScript syntax is used so Node can run this file directly.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";

type Json = Record<string, unknown>;

const isCli = /mockServer\.(ts|js)$/.test(process.argv[1] ?? "") && process.argv.includes("serve");

export interface MockOptions {
  password?: string;
  port?: number;
  directory?: string;
  /** Delay between streamed events. */
  stepMs?: number;
  noModels?: boolean;
  /** Persist sessions to this JSON file so a restarted mock keeps its history. */
  stateFile?: string;
  /** When set, `GET /api/session` paginates with opaque offset cursors. */
  sessionPageSize?: number;
}

interface MockSession {
  info: Json & { id: string; title?: string };
  messages: Json[];
  permissions: Json[];
  forms: Json[];
  interrupted: boolean;
  waiters: Map<string, (value: unknown) => void>;
  files: Json[];
}

export interface MockServer {
  url: string;
  password: string;
  port: number;
  requests: { method: string; path: string; body?: unknown }[];
  sessions: Map<string, MockSession>;
  dropConnections(): void;
  emit(event: Json): void;
  setNoModels(value: boolean): void;
  close(): Promise<void>;
}

let counter = 0;
function id(prefix: string): string {
  counter++;
  return `${prefix}_${Date.now().toString(16)}${counter.toString().padStart(4, "0")}mock`;
}

const MODELS = [
  {
    id: "mock-fast",
    modelID: "mock-fast",
    providerID: "mock",
    name: "Mock Fast",
    type: "chat",
    enabled: true,
    status: "active",
    variants: [],
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
  {
    id: "mock-smart",
    modelID: "mock-smart",
    providerID: "mock",
    name: "Mock Smart",
    type: "chat",
    enabled: true,
    status: "active",
    variants: [{ id: "low" }, { id: "high" }],
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  },
];

const AGENTS = [
  { id: "build", name: "Build", description: "The default agent.", mode: "primary", hidden: false, permissions: [] },
  { id: "plan", name: "Plan", description: "Read-only planning agent.", mode: "primary", hidden: false, permissions: [] },
  { id: "general", name: "General", mode: "subagent", hidden: false, permissions: [] },
  { id: "title", name: "Title", mode: "primary", hidden: true, permissions: [] },
];

const SKILLS = [
  {
    id: "mock-review",
    name: "Code review",
    description: "Review code changes.",
    autoinvoke: true,
    path: "/work/.opencode/skills/review/SKILL.md",
    content: "---\nname: Code review\n---\nReview code changes.",
  },
];

const PATCH = "Index: src/a.txt\n===================================================================\n--- src/a.txt\n+++ src/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n";

export function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const password = opts.password ?? randomBytes(12).toString("hex");
  const directory = opts.directory ?? process.cwd();
  const stepMs = opts.stepMs ?? 10;
  let noModels = opts.noModels ?? false;
  const sessions = new Map<string, MockSession>();
  const clients = new Set<http.ServerResponse>();
  const requests: MockServer["requests"] = [];
  const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

  if (opts.stateFile && fs.existsSync(opts.stateFile)) {
    const saved = JSON.parse(fs.readFileSync(opts.stateFile, "utf8")) as Pick<MockSession, "info" | "messages" | "files">[];
    for (const s of saved) sessions.set(s.info.id, { ...s, permissions: [], forms: [], interrupted: false, waiters: new Map() });
  }
  function persist(): void {
    if (!opts.stateFile) return;
    const data = [...sessions.values()].map((s) => ({ info: s.info, messages: s.messages, files: s.files }));
    fs.writeFileSync(opts.stateFile, JSON.stringify(data));
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function emit(event: Json): void {
    const full = { id: id("evt"), created: Date.now(), ...event };
    const line = `data: ${JSON.stringify(full)}\n\n`;
    for (const c of clients) c.write(line);
  }

  function send(res: http.ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }

  function notFound(res: http.ServerResponse, tag = "NotFoundError"): void {
    send(res, 404, { _tag: tag, message: "Not found" });
  }

  function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString("utf8")));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  function newSession(body: Json | undefined): MockSession {
    const now = Date.now();
    const sid = id("ses");
    const location = (body?.location as Json | undefined) ?? { directory };
    const info: MockSession["info"] = {
      id: sid,
      projectID: "proj_mock",
      agent: (body?.agent as string) ?? "build",
      model: (body?.model as Json) ?? { id: MODELS[0].id, providerID: "mock" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
      location,
    };
    if (body?.permissions) info.permissions = body.permissions;
    const s: MockSession = { info, messages: [], permissions: [], forms: [], interrupted: false, waiters: new Map(), files: [] };
    sessions.set(sid, s);
    persist();
    emit({ type: "session.created", data: { sessionID: sid, slug: "mock", version: "mock", projectID: "proj_mock", location } });
    return s;
  }

  async function runPrompt(s: MockSession, text: string, files: Json[] | undefined, userId: string): Promise<void> {
    const sid = s.info.id;
    const tools: Json[] = [];
    const startTime = Date.now();
    s.interrupted = false;
    s.info.time = { ...(s.info.time as Json), busy: startTime, updated: startTime };
    const userMsg: Json = { id: userId, type: "user", text, time: { created: startTime } };
    if (files && files.length > 0) userMsg.files = files;
    s.messages.push(userMsg);
    emit({ type: "session.inbox.enqueued", data: { sessionID: sid, inboxID: userId, item: { type: "user", payload: { text, files }, delivery: "steer" } } });
    emit({ type: "session.execution.started", data: { sessionID: sid } });
    emit({ type: "session.inbox.delivered", data: { sessionID: sid, inboxID: userId } });

    if (text.includes("[crash]") && isCli) {
      setTimeout(() => process.exit(3), 5);
      return;
    }
    if (text.includes("[error]")) {
      await sleep(stepMs);
      const error = { type: "provider_auth", message: "No provider configured: missing API key for provider 'mock'" };
      s.messages.push({ id: id("msg"), type: "idle", outcome: "failed", error, time: { created: Date.now() } });
      emit({ type: "session.execution.failed", data: { sessionID: sid, error } });
      finish(s);
      return;
    }

    let msgId = id("msg");
    let content: Json[] = [];
    const model = s.info.model as Json;
    const agent = s.info.agent as string;
    const stepStart = () => {
      msgId = id("msg");
      content = [];
      s.messages.push({ id: msgId, type: "assistant", agent, model, content, time: { created: Date.now() } });
      emit({ type: "session.step.started", data: { sessionID: sid, assistantMessageID: msgId, agent, model, started: Date.now() } });
    };
    const stepEnd = (finishReason: string, changed: string[] = []) => {
      const m = s.messages.find((x) => x.id === msgId) as Json;
      m.finish = finishReason;
      (m.time as Json).completed = Date.now();
      emit({
        type: "session.step.ended",
        data: { sessionID: sid, assistantMessageID: msgId, finish: finishReason, cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, files: changed },
      });
    };
    const streamText = async (kind: "text" | "reasoning", full: string, ordinal: number): Promise<boolean> => {
      const part: Json = { type: kind, text: "" };
      content.push(part);
      emit({ type: `session.${kind}.started`, data: { sessionID: sid, assistantMessageID: msgId, ordinal } });
      const chunks = full.match(/[\s\S]{1,12}/g) ?? [];
      for (const delta of chunks) {
        if (s.interrupted) return false;
        part.text = (part.text as string) + delta;
        emit({ type: `session.${kind}.delta`, data: { sessionID: sid, assistantMessageID: msgId, ordinal, delta } });
        await sleep(text.includes("[slow]") ? 80 : stepMs);
      }
      emit({ type: `session.${kind}.ended`, data: { sessionID: sid, assistantMessageID: msgId, ordinal, text: full } });
      return true;
    };
    const tool = async (name: string, input: Json): Promise<Json> => {
      const toolId = id("call");
      const part: Json = { type: "tool", id: toolId, name, state: { status: "streaming", input: "" }, time: { created: Date.now() } };
      content.push(part);
      tools.push(part);
      emit({ type: "session.tool.input.started", data: { sessionID: sid, assistantMessageID: msgId, id: toolId, name } });
      const inputText = JSON.stringify(input);
      emit({ type: "session.tool.input.delta", data: { sessionID: sid, assistantMessageID: msgId, id: toolId, delta: inputText } });
      emit({ type: "session.tool.input.ended", data: { sessionID: sid, assistantMessageID: msgId, id: toolId, text: inputText } });
      emit({ type: "session.tool.called", data: { sessionID: sid, assistantMessageID: msgId, id: toolId, input, executed: false } });
      part.state = { status: "running", input, metadata: {} };
      await sleep(stepMs);
      return part;
    };
    const toolDone = (part: Json, output: string, metadata: Json = {}) => {
      const input = (part.state as Json).input;
      part.state = { status: "completed", input, content: [{ type: "text", text: output }], metadata };
      emit({ type: "session.tool.success", data: { sessionID: sid, assistantMessageID: msgId, id: part.id, content: [{ type: "text", text: output }], metadata, executed: false } });
    };
    const toolFail = (part: Json, message: string) => {
      const input = (part.state as Json).input;
      const error = { type: "rejected", message };
      part.state = { status: "error", input, error };
      emit({ type: "session.tool.failed", data: { sessionID: sid, assistantMessageID: msgId, id: part.id, error, executed: false } });
    };
    const waitFor = (key: string) => new Promise((resolve) => s.waiters.set(key, resolve));

    stepStart();
    if (!(await streamText("reasoning", "Let me think about the request.", 0))) return interrupted(s, msgId);

    if (text.includes("[permission]")) {
      const part = await tool("edit", { path: "src/a.txt", oldString: "a", newString: "b" });
      const reqId = id("per");
      const files = [{ file: "src/a.txt", patch: PATCH, status: "modified", additions: 1, deletions: 1 }];
      const request = { id: reqId, sessionID: sid, action: "edit", resources: ["src/a.txt"], save: ["*"], metadata: { files }, source: { type: "tool", messageID: msgId, id: part.id } };
      s.permissions.push(request);
      emit({ type: "permission.asked", data: request });
      const decision = await waitFor(reqId);
      if (s.interrupted) return interrupted(s, msgId);
      if (decision === "reject") {
        toolFail(part, "The user rejected permission to use this specific tool call.");
      } else {
        toolDone(part, "Edited src/a.txt (1 replacement)", { files });
        s.files = files;
      }
      stepEnd("tool-calls", decision === "reject" ? [] : ["src/a.txt"]);
      stepStart();
    }

    if (text.includes("[question]")) {
      const part = await tool("question", { questions: [{ question: "Favorite color?" }] });
      const formId = id("frm");
      const form = {
        id: formId,
        sessionID: sid,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: msgId, id: part.id } },
        fields: [
          {
            key: "q0",
            title: "Favorite color",
            description: "What is your favorite color?",
            type: "string",
            options: [
              { value: "Red", label: "Red" },
              { value: "Blue", label: "Blue" },
            ],
            custom: true,
          },
        ],
      };
      s.forms.push(form);
      emit({ type: "form.created", data: { form } });
      const answer = (await waitFor(formId)) as Json | null;
      if (s.interrupted) return interrupted(s, msgId);
      toolDone(part, `User answered: ${JSON.stringify(answer)}`);
      stepEnd("tool-calls");
      stepStart();
    }

    if (text.includes("[todo]")) {
      const todos = [
        { content: "Read the code", status: "completed" },
        { content: "Write the fix", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ];
      const part = await tool("todowrite", { todos });
      toolDone(part, "Todos updated: 1/3 completed", { todos });
      stepEnd("tool-calls");
      stepStart();
    }

    if (text.includes("[drop]")) {
      setTimeout(() => {
        for (const c of clients) c.destroy();
        clients.clear();
      }, stepMs * 3);
    }

    const reply = text.includes("[slow]")
      ? Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
      : `**Echo:** ${text.replace(/\[[a-z]+\]/g, "").trim() || "(empty)"}\n\n\`\`\`ts\nconst answer: number = 42;\n\`\`\`\n\n- item one\n- item two\n`;
    if (!(await streamText("text", reply, 0))) return interrupted(s, msgId);
    stepEnd("stop");
    emit({ type: "session.usage.updated", data: { sessionID: sid, cost: 0.001, tokens: { input: 20, output: 10, reasoning: 2, cache: { read: 0, write: 0 } } } });
    s.messages.push({ id: id("msg"), type: "idle", outcome: "succeeded", time: { created: Date.now() } });
    emit({ type: "session.execution.succeeded", data: { sessionID: sid } });
    finish(s);
    if (!s.info.title) {
      s.info.title = text.replace(/\[[a-z]+\]/g, "").trim().slice(0, 40) || "Mock session";
      emit({ type: "session.renamed", data: { sessionID: sid, title: s.info.title } });
    }
  }

  function finish(s: MockSession): void {
    const now = Date.now();
    s.info.time = { ...(s.info.time as Json), idle: now, updated: now };
    const lastUser = [...s.messages].reverse().find((x) => x.type === "user") as Json | undefined;
    // A dismissed question can end a turn without leaving an idle marker in history and with
    // `time.busy` newer than `time.idle`. Reproduce that so a resync must not re-lock the composer.
    if (typeof lastUser?.text === "string" && lastUser.text.includes("[cancel-stale]")) {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i].type === "idle") {
          s.messages.splice(i, 1);
          break;
        }
      }
      s.info.time = { ...(s.info.time as Json), busy: now + 105, updated: Date.now() };
    }
    persist();
  }

  function interrupted(s: MockSession, msgId: string): void {
    const m = s.messages.find((x) => x.id === msgId) as Json | undefined;
    if (m) (m.time as Json).completed = Date.now();
    emit({ type: "session.step.failed", data: { sessionID: s.info.id, assistantMessageID: msgId, error: { type: "aborted", message: "Step interrupted" } } });
    s.messages.push({ id: id("msg"), type: "idle", outcome: "interrupted", time: { created: Date.now() } });
    emit({ type: "session.execution.interrupted", data: { sessionID: s.info.id, reason: "user" } });
    finish(s);
    // Reproduce a real 2.2.7 quirk: after an interrupt, `time.busy` can end up newer than
    // `time.idle`, which used to make the extension re-mark the session as busy on reconcile.
    const lastUser = [...s.messages].reverse().find((x) => x.type === "user") as Json | undefined;
    if (typeof lastUser?.text === "string" && lastUser.text.includes("[stale-busy]")) {
      s.info.time = { ...(s.info.time as Json), busy: Number((s.info.time as Json).idle) + 105, updated: Date.now() };
      persist();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
    requests.push({ method: req.method ?? "GET", path: path + url.search, body });

    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="Secure Area"' });
      res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
      return;
    }

    if (path === "/api/info") return send(res, 200, { version: "2.2.7-mock", pid: process.pid, urls: [], paths: {}, capabilities: {} });
    if (path === "/api/location") return send(res, 200, { directory, project: { id: "proj_mock", directory } });
    if (path === "/api/model") return send(res, 200, { location: { directory }, data: noModels ? [] : MODELS });
    if (path === "/api/model/default") return send(res, 200, { location: { directory }, data: noModels ? null : MODELS[0] });
    if (path === "/api/agent") return send(res, 200, { location: { directory }, data: AGENTS });
    if (path === "/api/skill") return send(res, 200, { location: { directory }, data: SKILLS });
    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", data: {} })}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(": heartbeat\n\n"), 1000);
      req.on("close", () => {
        clearInterval(hb);
        clients.delete(res);
      });
      return;
    }
    if (path === "/api/session" && req.method === "GET") {
      const dir = url.searchParams.get("directory");
      const list = [...sessions.values()]
        .map((s) => s.info)
        .filter((i) => !dir || (i.location as Json).directory === dir)
        .sort((a, b) => ((b.time as Json).updated as number) - ((a.time as Json).updated as number));
      const pageSize = (opts.sessionPageSize ?? Number(url.searchParams.get("limit") ?? 50)) || 50;
      const start = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const page = list.slice(start, start + pageSize);
      const next = start + pageSize < list.length ? String(start + pageSize) : null;
      return send(res, 200, { data: page, cursor: { next } });
    }
    if (path === "/api/session" && req.method === "POST") {
      return send(res, 200, { data: newSession(body as Json | undefined).info });
    }

    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (m) {
      const s = sessions.get(decodeURIComponent(m[1]));
      if (!s) return notFound(res, "SessionNotFoundError");
      const rest = m[2] ?? "";
      const b = (body ?? {}) as Json;
      if (rest === "" && req.method === "GET") return send(res, 200, { data: s.info });
      if (rest === "" && req.method === "DELETE") {
        sessions.delete(s.info.id);
        persist();
        emit({ type: "session.deleted", data: { sessionID: s.info.id } });
        return send(res, 204);
      }
      if (rest === "" && req.method === "PATCH") {
        if (typeof b.title === "string") s.info.title = b.title;
        return send(res, 200, { data: s.info });
      }
      if (rest === "message") {
        if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
          return send(res, 400, { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" });
        }
        const order = url.searchParams.get("order") ?? "desc";
        const list = order === "asc" ? s.messages : [...s.messages].reverse();
        return send(res, 200, { data: list, cursor: {} });
      }
      if (rest === "prompt") {
        const userId = id("msg");
        void runPrompt(s, String(b.text ?? ""), b.files as Json[] | undefined, userId);
        return send(res, 200, { data: { id: userId, sessionID: s.info.id, type: "user", payload: { text: b.text }, delivery: "steer" } });
      }
      if (rest === "interrupt") {
        s.interrupted = true;
        for (const [, resolve] of s.waiters) resolve(null);
        s.waiters.clear();
        return send(res, 200, { interrupted: true });
      }
      if (rest === "agent") {
        s.info.agent = b.agent;
        emit({ type: "session.agent.selected", data: { sessionID: s.info.id, agent: b.agent } });
        return send(res, 204);
      }
      if (rest === "model") {
        s.info.model = b.model;
        emit({ type: "session.model.selected", data: { sessionID: s.info.id, model: b.model } });
        return send(res, 204);
      }
      if (rest === "permission") return send(res, 200, { data: s.permissions });
      const pm = /^permission\/([^/]+)\/reply$/.exec(rest);
      if (pm) {
        const reqId = decodeURIComponent(pm[1]);
        if (!s.permissions.some((p) => p.id === reqId)) return notFound(res, "PermissionNotFoundError");
        s.permissions = s.permissions.filter((p) => p.id !== reqId);
        emit({ type: "permission.replied", data: { sessionID: s.info.id, requestID: reqId, reply: b.decision } });
        s.waiters.get(reqId)?.(b.decision);
        s.waiters.delete(reqId);
        return send(res, 204);
      }
      if (rest === "form") return send(res, 200, { data: s.forms });
      const fm = /^form\/([^/]+)(\/reply)?$/.exec(rest);
      if (fm) {
        const formId = decodeURIComponent(fm[1]);
        if (!s.forms.some((f) => f.id === formId)) return notFound(res, "FormNotFoundError");
        s.forms = s.forms.filter((f) => f.id !== formId);
        if (fm[2]) emit({ type: "form.replied", data: { id: formId, sessionID: s.info.id, answer: b.answer } });
        else emit({ type: "form.cancelled", data: { id: formId, sessionID: s.info.id } });
        s.waiters.get(formId)?.(fm[2] ? b.answer : null);
        s.waiters.delete(formId);
        return send(res, 204);
      }
      if (rest === "diff") return send(res, 200, { data: s.files });
    }

    if (path === "/__mock/drop") {
      for (const c of clients) c.destroy();
      clients.clear();
      return send(res, 204);
    }
    return notFound(res);
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        password,
        port,
        requests,
        sessions,
        dropConnections() {
          for (const c of clients) c.destroy();
          clients.clear();
        },
        emit,
        setNoModels(value: boolean) {
          noModels = value;
        },
        close() {
          for (const c of clients) c.destroy();
          clients.clear();
          return new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

// CLI entry: behaves like `opencode serve` for process-management tests.
if (isCli) {
  const portIdx = process.argv.indexOf("--port");
  const port = portIdx > 0 ? Number(process.argv[portIdx + 1]) : 0;
  const envPassword = process.env.OPENCODE_PASSWORD;
  if (process.env.MOCK_FAIL_START) {
    console.error("mock: simulated startup failure");
    process.exit(2);
  }
  void startMockServer({ port, password: envPassword, directory: process.cwd(), stateFile: process.env.MOCK_STATE_FILE }).then((srv) => {
    console.log(`server listening on ${srv.url}`);
    if (!envPassword) console.log(`server password ${srv.password}`);
    const stop = () => void srv.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}
