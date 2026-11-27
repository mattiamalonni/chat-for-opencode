import type * as Sdk from "@opencode/client";
import type { SdkHost } from "../sdk/bridge";
import type {
  AgentInfo,
  AttemptStatus,
  CommandInfo,
  ConnectAttempt,
  CredentialSummary,
  FileAttachment,
  FileDiff,
  FormRequest,
  FormValue,
  IntegrationInfo,
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
import type { ServerEvent } from "../shared/api";

/**
 * A connection is either the embedded SDK host or a generated client pointed at the user's own
 * endpoint. `key` identifies it for staleness checks; no URL/password/HTTP state lives here in the
 * embedded case.
 */
export interface Connection {
  key: string;
  embedded: boolean;
  baseUrl: string;
  password?: string;
  directory?: string;
  api: SdkHost;
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

/** The generated client rejects with plain objects; keep one error type for the rest of the extension. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return new ApiError(err.message, 0);
  const o = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const status = typeof o.status === "number" ? o.status : 0;
  const tag = typeof o._tag === "string" ? o._tag : undefined;
  const message = typeof o.message === "string" ? o.message : String(err);
  return new ApiError(message, status, tag);
}

/**
 * Typed facade over OpenCode's generated client. Every call goes straight to the SDK groups,
 * in memory for the embedded host.
 * The public surface is deliberately unchanged so the chat controller, Connect panel and tests keep
 * working against the same interface.
 */
export class OpenCodeClient {
  private constructor(readonly conn: Connection) {}

  static create(conn: Connection): OpenCodeClient {
    return new OpenCodeClient(conn);
  }

  private get api(): SdkHost {
    return this.conn.api;
  }

  /** `undefined` means "use the connection's own directory". */
  private location(directory?: string): { directory?: string } | undefined {
    const dir = directory ?? this.conn.directory;
    return dir ? { directory: dir } : undefined;
  }

  /** Request options for the generated client: cancels the call when `signal` aborts. */
  private req(signal?: AbortSignal): { signal: AbortSignal } | undefined {
    return signal ? { signal } : undefined;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toApiError(err);
    }
  }

  async info(signal?: AbortSignal): Promise<ServerInfo> {
    return await this.call(() => this.api.server.info(this.req(signal)));
  }

  async listSessionsPage(
    directory?: string,
    limit = 50,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{ items: SessionInfo[]; next?: string }> {
    const res = await this.call(() =>
      this.api.session.list(
        {
          directory,
          limit,
          cursor,
          order: cursor ? undefined : "desc",
          parentID: cursor ? undefined : null,
        },
        this.req(signal),
      ),
    );
    return { items: res.data, next: res.cursor?.next ?? undefined };
  }

  async listSessions(directory?: string, limit = 50): Promise<SessionInfo[]> {
    return (await this.listSessionsPage(directory, limit)).items;
  }

  async listChildSessions(parentID: string, directory?: string, limit = 100): Promise<SessionInfo[]> {
    const res = await this.call(() => this.api.session.list({ parentID, directory, limit, order: "desc" }));
    return res.data;
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    const directory = input.directory ?? this.conn.directory;
    return await this.call(() =>
      this.api.session.create({
        location: directory ? { directory } : undefined,
        agent: input.agent,
        model: input.model,
        permissions: input.permissions?.length ? input.permissions : undefined,
      }),
    );
  }

  async getSession(id: string, signal?: AbortSignal): Promise<SessionInfo> {
    return await this.call(() => this.api.session.get({ sessionID: id }, this.req(signal)));
  }

  async deleteSession(id: string): Promise<void> {
    await this.call(() => this.api.session.remove({ sessionID: id }));
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.call(() => this.api.session.update({ sessionID: id, title }));
  }

  /** Full history in chronological order (follows pagination up to `max` messages). */
  async messages(id: string, max = 2000, signal?: AbortSignal): Promise<SessionMessage[]> {
    const out: SessionMessage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.call(() =>
        this.api.message.list({ sessionID: id, limit: 200, order: cursor ? undefined : "asc", cursor }, this.req(signal)),
      );
      out.push(...res.data);
      cursor = res.data.length > 0 ? (res.cursor?.next ?? undefined) : undefined;
    } while (cursor && out.length < max);
    return out;
  }

  /** Messages added after `lastId`; `undefined` means the overlap was compacted away. */
  async messagesNewerThan(id: string, lastId: string, limit = 200, signal?: AbortSignal): Promise<SessionMessage[] | undefined> {
    const res = await this.call(() => this.api.message.list({ sessionID: id, order: "desc", limit }, this.req(signal)));
    const page = res.data;
    const index = page.findIndex((m) => !!m && typeof m === "object" && m.id === lastId);
    return index < 0 ? undefined : page.slice(0, index).reverse();
  }

  async prompt(id: string, text: string, files: FileAttachment[] = [], delivery?: "steer" | "queue"): Promise<{ id: string }> {
    const res = await this.call(() => this.api.session.prompt({ sessionID: id, text, files, delivery }));
    return { id: String(res.id) };
  }

  async command(id: string, name: string, text: string, files: FileAttachment[] = [], delivery?: "steer" | "queue"): Promise<void> {
    await this.call(() => this.api.session.command({ sessionID: id, name, text, files, delivery }));
  }

  /** Omitting `before` copies the whole history; an id copies everything before that message. */
  async forkSession(id: string, before?: string): Promise<SessionInfo> {
    return await this.call(() => this.api.session.fork({ sessionID: id, ...(before ? { before } : {}) }));
  }

  async inbox(id: string, signal?: AbortSignal): Promise<InboxItem[]> {
    return await this.call(() => this.api.session.inbox.list({ sessionID: id }, this.req(signal)));
  }

  async setInboxDelivery(id: string, inboxId: string, delivery: InboxDelivery): Promise<void> {
    await this.call(() => this.api.session.inbox.update({ sessionID: id, inboxID: inboxId, delivery }));
  }

  async cancelInbox(id: string, inboxId: string): Promise<void> {
    await this.call(() => this.api.session.inbox.cancel({ sessionID: id, inboxID: inboxId }));
  }

  async compact(id: string): Promise<void> {
    await this.call(() => this.api.session.compact({ sessionID: id }));
  }

  async revertStage(id: string, messageID: string, files?: boolean): Promise<void> {
    await this.call(() => this.api.session.revert.stage({ sessionID: id, messageID, files }));
  }

  async revertCommit(id: string): Promise<void> {
    await this.call(() => this.api.session.revert.commit({ sessionID: id }));
  }

  async revertClear(id: string): Promise<void> {
    await this.call(() => this.api.session.revert.clear({ sessionID: id }));
  }

  async waitIdle(id: string): Promise<void> {
    await this.call(() => this.api.session.wait({ sessionID: id }));
  }

  async interrupt(id: string): Promise<boolean> {
    const res = await this.call(() => this.api.session.interrupt({ sessionID: id }));
    return res.interrupted;
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await this.call(() => this.api.session.switchAgent({ sessionID: id, agent }));
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await this.call(() => this.api.session.switchModel({ sessionID: id, model }));
  }

  async permissions(id: string, signal?: AbortSignal): Promise<PermissionRequest[]> {
    return await this.call(() => this.api.permission.list({ sessionID: id }, this.req(signal)));
  }

  async replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.call(() => this.api.permission.reply({ sessionID: sessionId, requestID: requestId, decision }));
  }

  async forms(id: string, signal?: AbortSignal): Promise<FormRequest[]> {
    return await this.call(() => this.api.session.form.list({ sessionID: id }, this.req(signal)));
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, FormValue>): Promise<void> {
    await this.call(() => this.api.session.form.reply({ sessionID: sessionId, formID: formId, answer }));
  }

  async cancelForm(sessionId: string, formId: string): Promise<void> {
    await this.call(() => this.api.session.form.cancel({ sessionID: sessionId, formID: formId }));
  }

  async diff(id: string): Promise<FileDiff[]> {
    return await this.call(() => this.api.session.diff({ sessionID: id }));
  }

  async models(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.call(() => this.api.model.list({ types: ["chat"], location: this.location() }, this.req(signal)));
    return res.data;
  }

  async defaultModel(signal?: AbortSignal): Promise<ModelInfo | null> {
    const res = await this.call(() => this.api.model.default({ location: this.location() }, this.req(signal)));
    return res.data;
  }

  async agents(signal?: AbortSignal): Promise<AgentInfo[]> {
    const res = await this.call(() => this.api.agent.list({ location: this.location() }, this.req(signal)));
    return res.data;
  }

  async skills(): Promise<SkillInfo[]> {
    const res = await this.call(() => this.api.skill.list({ location: this.location() }));
    return res.data;
  }

  async commands(): Promise<CommandInfo[]> {
    const res = await this.call(() => this.api.command.list({ location: this.location() }));
    return res.data;
  }

  // ---- integrations / credentials (Connect panel) -----------------------------------------

  async integrations(directory?: string, signal?: AbortSignal): Promise<IntegrationInfo[]> {
    const res = await this.call(() => this.api.integration.list({ location: this.location(directory) }, this.req(signal)));
    return res.data;
  }

  async integration(id: string, directory?: string, signal?: AbortSignal): Promise<IntegrationInfo> {
    const res = await this.call(() =>
      this.api.integration.get({ integrationID: id, location: this.location(directory) }, this.req(signal)),
    );
    return res.data;
  }

  /** A key goes straight to the SDK router; the extension never stores or logs it. */
  async connectKey(
    id: string,
    key: string,
    answer?: Record<string, FormValue>,
    label?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(() =>
      this.api.integration.connect.key({ integrationID: id, location: this.location(directory), key, answer, label }, this.req(signal)),
    );
  }

  async connectExternal(
    id: string,
    methodID: string,
    answer?: Record<string, FormValue>,
    label?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(() =>
      this.api.integration.connect.external(
        {
          integrationID: id,
          location: this.location(directory),
          methodID,
          answer,
          label,
        },
        this.req(signal),
      ),
    );
  }

  async startOAuth(
    id: string,
    methodID: string,
    answer?: Record<string, FormValue>,
    label?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<ConnectAttempt> {
    const res = await this.call(() =>
      this.api.integration.oauth.connect(
        { integrationID: id, location: this.location(directory), methodID, answer, label },
        this.req(signal),
      ),
    );
    return res.data;
  }

  async oauthStatus(id: string, attemptID: string, directory?: string, signal?: AbortSignal): Promise<AttemptStatus> {
    const res = await this.call(() =>
      this.api.integration.oauth.status({ integrationID: id, attemptID, location: this.location(directory) }, this.req(signal)),
    );
    return res.data;
  }

  async completeOAuth(id: string, attemptID: string, code: string, directory?: string, signal?: AbortSignal): Promise<void> {
    await this.call(() =>
      this.api.integration.oauth.complete({ integrationID: id, attemptID, code, location: this.location(directory) }, this.req(signal)),
    );
  }

  async cancelOAuth(id: string, attemptID: string, directory?: string, signal?: AbortSignal): Promise<void> {
    await this.call(() =>
      this.api.integration.oauth.cancel({ integrationID: id, attemptID, location: this.location(directory) }, this.req(signal)),
    );
  }

  async startCommand(id: string, methodID: string, label?: string, directory?: string, signal?: AbortSignal): Promise<ConnectAttempt> {
    const res = await this.call(() =>
      this.api.integration.command.connect({ integrationID: id, location: this.location(directory), methodID, label }, this.req(signal)),
    );
    return res.data;
  }

  async commandStatus(id: string, attemptID: string, directory?: string, signal?: AbortSignal): Promise<AttemptStatus> {
    const res = await this.call(() =>
      this.api.integration.command.status({ integrationID: id, attemptID, location: this.location(directory) }, this.req(signal)),
    );
    return res.data;
  }

  async cancelCommand(id: string, attemptID: string, directory?: string, signal?: AbortSignal): Promise<void> {
    await this.call(() =>
      this.api.integration.command.cancel({ integrationID: id, attemptID, location: this.location(directory) }, this.req(signal)),
    );
  }

  /** Raw credentials include secrets; callers must project them before crossing the webview boundary. */
  async credentials(signal?: AbortSignal): Promise<CredentialSummary[]> {
    const raw = await this.call(() => this.api.credential.list(this.req(signal)));
    return raw.flatMap((item): CredentialSummary[] => {
      const type = item.value.type;
      if (type !== "key" && type !== "oauth" && type !== "external") return [];
      return [{ id: item.id, integrationID: item.integrationID, label: item.label, active: item.active, type }];
    });
  }

  async renameCredential(id: string, label: string, signal?: AbortSignal): Promise<void> {
    await this.call(() => this.api.credential.update({ credentialID: id, label }, this.req(signal)));
  }

  async deleteCredential(id: string, signal?: AbortSignal): Promise<void> {
    await this.call(() => this.api.credential.remove({ credentialID: id }, this.req(signal)));
  }

  async activateCredential(id: string, signal?: AbortSignal): Promise<void> {
    await this.call(() => this.api.credential.activate({ credentialID: id }, this.req(signal)));
  }

  /** Live events from the SDK: typed objects, still live-only. */
  subscribe(onEvent: (event: ServerEvent) => void, onClose: (error?: unknown) => void, signal: AbortSignal): void {
    const subscription = this.api.event.subscribe({ signal }) as AsyncIterable<Sdk.V2Event>;
    void (async () => {
      let failure: unknown;
      try {
        for await (const event of subscription) onEvent(event);
      } catch (err) {
        failure = err;
      } finally {
        onClose(failure);
      }
    })();
  }
}
