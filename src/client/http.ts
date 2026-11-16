import type {
  AgentInfo,
  FileAttachment,
  FileDiff,
  FormRequest,
  FormValue,
  ModelInfo,
  ModelRef,
  PermissionDecision,
  PermissionRequest,
  ServerInfo,
  SessionInfo,
  SessionMessage,
} from "../shared/api";

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
    private readonly timeoutMs = 30_000,
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
    const text = await res.text();
    if (!res.ok) {
      let message = text || res.statusText || `HTTP ${res.status}`;
      let tag: string | undefined;
      try {
        const parsed = JSON.parse(text) as { _tag?: string; message?: string };
        tag = parsed._tag;
        if (parsed.message) message = parsed.message;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(message, res.status, tag);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  info(signal?: AbortSignal): Promise<ServerInfo> {
    return this.request("GET", "api/info", { signal, timeoutMs: 5_000 });
  }

  async listSessions(directory?: string, limit = 50): Promise<SessionInfo[]> {
    const res = await this.request<{ data: SessionInfo[] }>("GET", "api/session", {
      query: { directory, limit, order: "desc", parentID: "null" },
    });
    return res.data;
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const body: Record<string, unknown> = {};
    if (input.directory) body.location = { directory: input.directory };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = input.model;
    if (input.permissions && input.permissions.length > 0) body.permissions = input.permissions;
    const res = await this.request<{ data: SessionInfo }>("POST", "api/session", { body });
    return res.data;
  }

  async getSession(id: string): Promise<SessionInfo> {
    const res = await this.request<{ data: SessionInfo }>("GET", `api/session/${encodeURIComponent(id)}`);
    return res.data;
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `api/session/${encodeURIComponent(id)}`);
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.request("PATCH", `api/session/${encodeURIComponent(id)}`, { body: { title } });
  }

  /** Full history in chronological order (follows pagination up to `max` messages). */
  async messages(id: string, max = 2000): Promise<SessionMessage[]> {
    const out: SessionMessage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ data: SessionMessage[]; cursor?: { next?: string | null } }>(
        "GET",
        `api/session/${encodeURIComponent(id)}/message`,
        // The server rejects `order` together with `cursor` ("Cursor cannot be combined with order").
        { query: cursor ? { limit: 200, cursor } : { order: "asc", limit: 200 } },
      );
      out.push(...res.data);
      cursor = res.data.length > 0 ? (res.cursor?.next ?? undefined) : undefined;
    } while (cursor && out.length < max);
    return out;
  }

  async prompt(id: string, text: string, files: FileAttachment[] = []): Promise<{ id: string }> {
    const body: Record<string, unknown> = { text };
    if (files.length > 0) body.files = files;
    const res = await this.request<{ data: { id: string } }>("POST", `api/session/${encodeURIComponent(id)}/prompt`, {
      body,
    });
    return res.data;
  }

  async interrupt(id: string): Promise<boolean> {
    const res = await this.request<{ interrupted: boolean }>(
      "POST",
      `api/session/${encodeURIComponent(id)}/interrupt`,
    );
    return res?.interrupted ?? false;
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await this.request("POST", `api/session/${encodeURIComponent(id)}/agent`, { body: { agent } });
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await this.request("POST", `api/session/${encodeURIComponent(id)}/model`, { body: { model } });
  }

  async permissions(id: string): Promise<PermissionRequest[]> {
    const res = await this.request<{ data: PermissionRequest[] }>(
      "GET",
      `api/session/${encodeURIComponent(id)}/permission`,
    );
    return res.data;
  }

  async replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.request(
      "POST",
      `api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: { decision } },
    );
  }

  async forms(id: string): Promise<FormRequest[]> {
    const res = await this.request<{ data: FormRequest[] }>("GET", `api/session/${encodeURIComponent(id)}/form`);
    return res.data;
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, FormValue>): Promise<void> {
    await this.request(
      "POST",
      `api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      { body: { answer } },
    );
  }

  async cancelForm(sessionId: string, formId: string): Promise<void> {
    await this.request(
      "DELETE",
      `api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
    );
  }

  async diff(id: string): Promise<FileDiff[]> {
    const res = await this.request<{ data: FileDiff[] }>("GET", `api/session/${encodeURIComponent(id)}/diff`);
    return res.data;
  }

  async models(): Promise<ModelInfo[]> {
    const res = await this.request<{ data: ModelInfo[] }>("GET", "api/model", { query: { types: "chat" } });
    return res.data;
  }

  async defaultModel(): Promise<ModelInfo | null> {
    const res = await this.request<{ data: ModelInfo | null }>("GET", "api/model/default");
    return res.data;
  }

  async agents(): Promise<AgentInfo[]> {
    const res = await this.request<{ data: AgentInfo[] }>("GET", "api/agent");
    return res.data;
  }

  eventUrl(): string {
    return this.url("api/event");
  }
}
