import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  FileAttachment,
  FileDiff,
  FormRequest,
  FormValue,
  InboxDelivery,
  InboxItem,
  ModelInfo,
  ModelRef,
  PermissionDecision,
  PermissionRequest,
  SkillInfo,
  ServerInfo,
  SessionInfo,
  SessionMessage,
} from "../shared/api";
import { DEFAULT_HTTP_TIMEOUT_MS } from "../shared/constants";
import { ENDPOINTS, endpointPath, type ApiEndpoint } from "./endpoints";

export interface Connection {
  baseUrl: string;
  password?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly tag?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface CreateSessionInput {
  directory?: string;
  agent?: string;
  model?: ModelRef;
  permissions?: PermissionRule[];
}

type Query = Record<string, string | number | boolean | undefined>;

/** A server error body is untrusted: never let a huge one flood the chat's notice UI. */
const MAX_ERROR_BODY = 4000;
/** Success bodies can be large (a session's full history), but not unbounded. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * Read a response body incrementally instead of buffering an unlimited `res.text()`.
 * Error bodies are truncated in place; success bodies beyond the cap fail the request, so a broken
 * server or proxy cannot exhaust the extension host's memory while the UI waits for JSON.
 */
async function readBoundedText(res: Response, limit: number, truncate: boolean): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, limit);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        if (truncate) break;
        throw new ApiError(`Response too large (over ${limit} bytes)`, 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}

export function authHeaders(conn: Connection): Record<string, string> {
  if (!conn.password) return {};
  const token = Buffer.from(`opencode:${conn.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/** Thin typed wrapper over the OpenCode v2 HTTP API (see docs/API_NOTES.md). */
export class OpenCodeClient {
  constructor(
    readonly conn: Connection,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  ) {}

  url(path: string, query?: Query): string {
    const url = new URL(path, this.conn.baseUrl.endsWith("/") ? this.conn.baseUrl : this.conn.baseUrl + "/");
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  headers(): Record<string, string> {
    return authHeaders(this.conn);
  }

  async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...this.headers() };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const res = await this.fetchImpl(this.url(path, options.query), { method, headers, body, signal });
    const text = await readBoundedText(res, res.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BODY, !res.ok);
    if (!res.ok) {
      const body = text.slice(0, MAX_ERROR_BODY);
      let message = body || res.statusText || `HTTP ${res.status}`;
      let tag: string | undefined;
      try {
        const parsed = JSON.parse(body) as { _tag?: string; message?: string };
        tag = parsed._tag;
        if (parsed.message) message = parsed.message;
      } catch {
        // non-JSON or truncated error body: keep the bounded raw text.
      }
      throw new ApiError(message.slice(0, MAX_ERROR_BODY), res.status, tag);
    }
    if (!text) return undefined as T;
    // A proxy can answer 200 with HTML or a truncated body. A raw SyntaxError here would escape as
    // an unclassified failure and (on the SSE side) look like a reason to reconnect forever.
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("Malformed JSON response from server", res.status, "malformedResponse");
    }
  }

  /** Build every request from the shared endpoint registry (also used by the contract gate). */
  private requestEndpoint<T>(
    endpoint: ApiEndpoint,
    params: Record<string, string> = {},
    options: { query?: Query; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.request<T>(endpoint.method, endpointPath(endpoint.path, params), options);
  }

  /** Unwrap `{ data: … }` envelopes: a missing/wrong field is a contract break, not `undefined`. */
  private data<T>(res: unknown, label: string): T {
    if (!res || typeof res !== "object" || !("data" in res)) {
      throw new ApiError(`Malformed ${label} response from server`, 200, "malformedResponse");
    }
    return (res as { data: T }).data;
  }

  /** Like `data()`, but also guards the array shape that callers spread/map directly. */
  private dataArray<T>(res: unknown, label: string): T[] {
    const data = this.data<unknown>(res, label);
    if (!Array.isArray(data)) throw new ApiError(`Malformed ${label} response from server`, 200, "malformedResponse");
    return data as T[];
  }

  async info(signal?: AbortSignal): Promise<ServerInfo> {
    const res = await this.requestEndpoint<{ version?: unknown }>(ENDPOINTS.info, {}, { signal, timeoutMs: 5_000 });
    if (!res || typeof res.version !== "string") {
      throw new ApiError("Malformed server info response", 200, "malformedResponse");
    }
    return res as ServerInfo;
  }

  /** Config documents and discovery sources, from lowest to highest priority. */
  async config(directory?: string): Promise<ConfigEntry[]> {
    const res = await this.requestEndpoint<ConfigEntry[]>(
      ENDPOINTS.config,
      {},
      {
        query: directory ? { "location[directory]": directory } : undefined,
      },
    );
    return Array.isArray(res) ? res : [];
  }

  /** One page of sessions plus the opaque cursor for the next page (if any). */
  async listSessionsPage(
    directory?: string,
    limit = 50,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ items: SessionInfo[]; next?: string }> {
    const res = await this.requestEndpoint<{ data: SessionInfo[]; cursor?: { next?: string | null } }>(
      ENDPOINTS.sessionList,
      {},
      {
        // `order` only applies to the first page; the cursor continues that ordering.
        query: cursor ? { directory, limit, parentID: "null", cursor } : { directory, limit, order: "desc", parentID: "null" },
        signal,
      },
    );
    return { items: this.dataArray<SessionInfo>(res, "session list"), next: res.cursor?.next ?? undefined };
  }

  async listSessions(directory?: string, limit = 50): Promise<SessionInfo[]> {
    return (await this.listSessionsPage(directory, limit)).items;
  }

  /** Child sessions of one session. The root list filters them out with `parentID=null`. */
  async listChildSessions(parentID: string, directory?: string, limit = 100): Promise<SessionInfo[]> {
    const res = await this.requestEndpoint<unknown>(
      ENDPOINTS.sessionList,
      {},
      {
        query: { directory, limit, parentID, order: "desc" },
      },
    );
    return this.dataArray<SessionInfo>(res, "child session list");
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const body: Record<string, unknown> = {};
    if (input.directory) body.location = { directory: input.directory };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = input.model;
    if (input.permissions && input.permissions.length > 0) body.permissions = input.permissions;
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.sessionCreate, {}, { body });
    return this.data<SessionInfo>(res, "session");
  }

  async getSession(id: string, signal?: AbortSignal): Promise<SessionInfo> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.sessionGet, { sessionID: id }, { signal });
    return this.data<SessionInfo>(res, "session");
  }

  async deleteSession(id: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.sessionDelete, { sessionID: id });
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.sessionRename, { sessionID: id }, { body: { title } });
  }

  /** Full history in chronological order (follows pagination up to `max` messages). */
  async messages(id: string, max = 2000, signal?: AbortSignal): Promise<SessionMessage[]> {
    const out: SessionMessage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.requestEndpoint<{ data?: unknown; cursor?: { next?: string | null } }>(
        ENDPOINTS.messages,
        { sessionID: id },
        // The server rejects `order` together with `cursor` ("Cursor cannot be combined with order").
        { query: cursor ? { limit: 200, cursor } : { order: "asc", limit: 200 }, signal },
      );
      const page = this.dataArray<SessionMessage>(res, "session history");
      out.push(...page);
      cursor = page.length > 0 ? (res.cursor?.next ?? undefined) : undefined;
    } while (cursor && out.length < max);
    return out;
  }

  /**
   * Messages added after `lastId`, using only `order=desc` (the cursor is opaque and may be
   * invalidated by compaction). Finds the last id we already had in the newest page and returns
   * the newer messages in chronological order. `undefined` means the overlap is unknown — history
   * was trimmed or compacted — so callers must fall back to a full `messages()` fetch.
   */
  async messagesNewerThan(id: string, lastId: string, limit = 200): Promise<SessionMessage[] | undefined> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.messages, { sessionID: id }, { query: { order: "desc", limit } });
    const page = this.dataArray<SessionMessage>(res, "session history");
    const index = page.findIndex((m) => !!m && typeof m === "object" && m.id === lastId);
    return index < 0 ? undefined : page.slice(0, index).reverse();
  }

  async prompt(id: string, text: string, files: FileAttachment[] = [], delivery?: "steer" | "queue"): Promise<{ id: string }> {
    const body: Record<string, unknown> = { text };
    if (files.length > 0) body.files = files;
    if (delivery) body.delivery = delivery;
    const res = await this.requestEndpoint<unknown>(
      ENDPOINTS.prompt,
      { sessionID: id },
      {
        body,
      },
    );
    return this.data<{ id: string }>(res, "prompt");
  }

  /** Runs the command's prompt template with `text` as its argument string. */
  async command(id: string, name: string, text: string, files: FileAttachment[] = [], delivery?: "steer" | "queue"): Promise<void> {
    const body: Record<string, unknown> = { name, text };
    if (files.length > 0) body.files = files;
    if (delivery) body.delivery = delivery;
    await this.requestEndpoint(ENDPOINTS.command, { sessionID: id }, { body });
  }

  /** Copy the session's history up to (but not including) `before` into a new session. */
  async forkSession(id: string, before: string): Promise<SessionInfo> {
    const res = await this.requestEndpoint<unknown>(
      ENDPOINTS.fork,
      { sessionID: id },
      {
        body: { before },
      },
    );
    return this.data<SessionInfo>(res, "fork");
  }

  /** Prompts still waiting in the inbox, oldest first (the server keeps insertion order). */
  async inbox(id: string): Promise<InboxItem[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.inbox, { sessionID: id });
    return this.dataArray<InboxItem>(res, "inbox");
  }

  /** Change how a queued item is delivered. `steer` makes it interrupt the current turn. */
  async setInboxDelivery(id: string, inboxId: string, delivery: InboxDelivery): Promise<void> {
    await this.requestEndpoint(
      ENDPOINTS.inboxDelivery,
      { sessionID: id, inboxID: inboxId },
      {
        body: { delivery },
      },
    );
  }

  async cancelInbox(id: string, inboxId: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.inboxCancel, { sessionID: id, inboxID: inboxId });
  }

  /** Durably admit a compaction request; the server runs it at the next step boundary. */
  async compact(id: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.compact, { sessionID: id }, { body: {} });
  }

  /**
   * Stage a reversible boundary at `messageID`. OpenCode restores the files changed after that
   * message right away (unless `files` is false); the boundary is applied by `revertCommit`.
   */
  async revertStage(id: string, messageID: string, files?: boolean): Promise<void> {
    await this.requestEndpoint(
      ENDPOINTS.revertStage,
      { sessionID: id },
      {
        body: files === undefined ? { messageID } : { messageID, files },
      },
    );
  }

  /** Apply the staged boundary: the target message and everything after it are dropped. */
  async revertCommit(id: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.revertCommit, { sessionID: id }, { body: {} });
  }

  /** Discard a staged boundary and restore the files it temporarily rolled back. */
  async revertClear(id: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.revertDelete, { sessionID: id });
  }

  /** Wait for the session's agent loop to become idle, so a revert can be staged. */
  async waitIdle(id: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.wait, { sessionID: id });
  }

  async interrupt(id: string): Promise<boolean> {
    const res = await this.requestEndpoint<{ interrupted: boolean }>(ENDPOINTS.interrupt, { sessionID: id });
    return res?.interrupted ?? false;
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.switchAgent, { sessionID: id }, { body: { agent } });
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.switchModel, { sessionID: id }, { body: { model } });
  }

  async permissions(id: string, signal?: AbortSignal): Promise<PermissionRequest[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.permissions, { sessionID: id }, { signal });
    return this.dataArray<PermissionRequest>(res, "permission list");
  }

  async replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.requestEndpoint(
      ENDPOINTS.permissionReply,
      { sessionID: sessionId, requestID: requestId },
      {
        body: { decision },
      },
    );
  }

  async forms(id: string, signal?: AbortSignal): Promise<FormRequest[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.forms, { sessionID: id }, { signal });
    return this.dataArray<FormRequest>(res, "form list");
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, FormValue>): Promise<void> {
    await this.requestEndpoint(
      ENDPOINTS.formReply,
      { sessionID: sessionId, formID: formId },
      {
        body: { answer },
      },
    );
  }

  async cancelForm(sessionId: string, formId: string): Promise<void> {
    await this.requestEndpoint(ENDPOINTS.formCancel, { sessionID: sessionId, formID: formId });
  }

  async diff(id: string): Promise<FileDiff[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.diff, { sessionID: id });
    return this.dataArray<FileDiff>(res, "diff");
  }

  async models(): Promise<ModelInfo[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.models, {}, { query: { types: "chat" } });
    return this.dataArray<ModelInfo>(res, "model list");
  }

  async defaultModel(): Promise<ModelInfo | null> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.modelDefault);
    return this.data<ModelInfo | null>(res, "default model");
  }

  async agents(): Promise<AgentInfo[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.agents);
    return this.dataArray<AgentInfo>(res, "agent list");
  }

  async skills(): Promise<SkillInfo[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.skills);
    return this.dataArray<SkillInfo>(res, "skill list");
  }

  async commands(): Promise<CommandInfo[]> {
    const res = await this.requestEndpoint<unknown>(ENDPOINTS.commands);
    return this.dataArray<CommandInfo>(res, "command list");
  }

  eventUrl(): string {
    return this.url(ENDPOINTS.event.path);
  }
}
