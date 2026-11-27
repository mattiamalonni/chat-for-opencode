import * as vscode from "vscode";
import type { OpenCodeClient } from "../../client/http";
import type { AgentInfo, FormRequest, InboxItem, ModelInfo, PermissionRequest, SessionInfo, SessionMessage } from "../../shared/api";
import { normalizeForm, normalizeList, normalizePermission, normalizeSessionInfo, normalizeSessionMessage } from "../../shared/adapter";
import type { ContractObservations } from "../../shared/contract";
import { emptyContract } from "../../shared/contract";
import { jitteredDelay } from "../../shared/constants";
import { sessionIsBusy } from "../../shared/chatReducer";
import type { ConnectionStatus, HostMessage, UiError } from "../../shared/protocol";
import { BoundedSet } from "../../shared/boundedSet";
import type { CatalogService } from "../catalogService";
import type { ContextTracker } from "../context";
import type { ControllerState } from "./controllerState";
import { translatedStrings, subagentSessionsFromMessages, LIVE_POLL_MS } from "./controllerSupport";
import type { ChatPermissionActions } from "./permissionActions";
import type { PermissionService } from "../permissionService";
import type { ChatRefreshActions } from "./refreshActions";
import type { ExecutionStateService } from "../executionState";
import type { ChatLifecycle } from "../lifecycle";
import type { SubagentTracker } from "../subagentTracker";
import { SESSION_KEY } from "../storageKeys";

export interface SessionServiceDeps {
  state: ControllerState;
  ctx: vscode.ExtensionContext;
  output: vscode.LogOutputChannel;
  lifecycle: ChatLifecycle;
  execution: ExecutionStateService;
  catalog: CatalogService;
  context: ContextTracker;
  subagents: SubagentTracker;
  permissions: PermissionService;
  attention: BoundedSet<string>;
  permissionActions: ChatPermissionActions;
  refreshActions: ChatRefreshActions;
  getClient(): OpenCodeClient | undefined;
  isVisible(): boolean;
  abortConnectionRequests(): void;
  clearTimers(): void;
  post(msg: HostMessage): void;
  setStatus(status: ConnectionStatus, error?: UiError): void;
  observeContract(observations: Partial<ContractObservations>): void;
  bestEffort<T>(label: string, promise: Promise<T>, fallback: T): Promise<T>;
  refreshSessions(): Promise<void>;
}

/** Session loading, reconnect resync, live polling and reconciliation. */
export class ChatSessionService {
  constructor(private readonly d: SessionServiceDeps) {}

  async loadAll(): Promise<void> {
    const client = this.d.getClient();
    if (!client || !this.d.state.folder) return;
    const generation = this.d.lifecycle.generations.load.bump();
    const stale = () => !this.d.lifecycle.generations.load.is(generation);
    this.d.state.contractObservations = {};
    this.d.state.contract = emptyContract;
    let catalogError: string | undefined;
    const signal = this.d.state.connectionAbort?.signal;
    const [models, defaultModel, agents] = await Promise.all([
      client.models(signal).catch((err: unknown) => {
        catalogError = err instanceof Error ? err.message : String(err);
        this.d.output.warn(`[chat] failed to load models: ${catalogError}`);
        return [] as ModelInfo[];
      }),
      client.defaultModel(signal).catch(() => null),
      client.agents(signal).catch((err: unknown) => {
        this.d.output.warn(`[chat] failed to load agents: ${String(err)}`);
        return [] as AgentInfo[];
      }),
    ]);
    // The contract report still observes the raw values: an adapter that silently drops malformed
    // entries must not hide a server version we cannot really support.
    // An aborted connection turns every fetch above into an empty fallback: never publish those.
    if (stale() || signal?.aborted) return;
    this.d.catalog.setModelsAndAgents(models, defaultModel, agents);
    const sessionId = this.d.state.sessionId ?? this.d.ctx.workspaceState.get<string>(SESSION_KEY(this.d.state.folder.uri.toString()));
    let session: SessionInfo | undefined;
    if (sessionId) {
      session = await this.d.bestEffort("load stored session", client.getSession(sessionId, signal), undefined);
      if (stale()) return;
    }
    // Plugin skills/commands are registered only once a session exists. With no session yet
    // (fresh window, or right after "New session") create a throwaway one so the `/` picker is
    // populated before the first prompt; the registrations survive deleting that session.
    if (!session && !this.d.catalog.isWarmedUp) {
      const tmp = await this.d.bestEffort(
        "create warm-up session",
        client.createSession({ directory: this.d.state.folder.uri.fsPath }),
        undefined,
      );
      if (tmp) {
        try {
          this.d.catalog.markWarmedUp();
          await this.d.catalog.refresh(client);
        } finally {
          await client.deleteSession(tmp.id).catch(() => {});
        }
      }
    }
    // Now that model/agent state is complete, a refreshed catalog (if any) can be posted safely.
    await this.d.catalog.refresh(client);
    if (stale()) return;
    this.d.observeContract({ version: this.d.state.version, models, agents, skills: this.d.catalog.skills });

    await this.d.refreshSessions();
    if (stale()) return;
    if (session) {
      await this.loadSession(session, stale);
    } else {
      if (stale()) return;
      this.d.state.sessionId = undefined;
      this.d.subagents.reset();
      this.d.catalog.publish();
      this.d.post({ type: "session", session: null });
      this.d.permissionActions.post();
    }
    /** Retry a catalog that is not ready yet, without treating a transient snapshot as final. */
    const retryCatalog = () => {
      if (stale()) return;
      this.d.state.catalogRetries++;
      const wait = jitteredDelay(500 * this.d.state.catalogRetries);
      this.d.lifecycle.schedule(
        "catalogRetry",
        () => {
          if (!stale()) void this.loadAll();
        },
        wait,
      );
    };
    // OpenCode 2.4 boots location services lazily: the first `/api/model` answer can be an empty
    // snapshot even when providers are configured (the `model.updated` event follows shortly after).
    // Give it a few short retries before showing the irreversible-looking "no provider" card.
    const MAX_CATALOG_RETRIES = 3;
    if (catalogError !== undefined) {
      // An empty array from a *failed* request is not evidence that the user has no provider.
      const s = translatedStrings();
      this.d.setStatus("error", {
        kind: "requestFailed",
        message: s["error.requestFailed"],
        detail: catalogError,
        actions: ["reconnect", "showLogs"],
      });
      if (this.d.state.catalogRetries < MAX_CATALOG_RETRIES) retryCatalog();
    } else if (this.d.catalog.models.length === 0) {
      if (this.d.state.catalogRetries < MAX_CATALOG_RETRIES) retryCatalog();
      else {
        const s = translatedStrings();
        this.d.setStatus("error", { kind: "noProvider", message: s["error.noProvider"], actions: ["login", "reconnect", "showLogs"] });
      }
    } else {
      this.d.state.catalogRetries = 0;
      this.d.setStatus("connected");
    }
    this.d.post({ type: "context", items: this.d.context.current() });
  }

  /** OpenCode registers plugin catalog items only once a session exists; keep the picker fresh. */
  async refreshSlashItems(): Promise<void> {
    const client = this.d.getClient();
    if (client) await this.d.catalog.refresh(client);
  }

  /**
   * Applies only the messages added since the last load. The event stream is live-only and has no
   * replay, but the history endpoint can find the overlap by id (`order=desc`). When nothing (or
   * only a few messages) changed, the webview keeps its scroll position, attachments and draft
   * instead of being rebuilt from a full `session` payload.
   *
   * Returns `false` when the overlap is unknown (history trimmed/compacted) so the caller falls
   * back to a full load. This is best-effort: a failed tail fetch must never lose a conversation.
   */
  async resyncTail(
    sid: string,
    rawInfo: SessionInfo,
    stale: () => boolean,
    busyOverride?: boolean,
    prefetched?: SessionMessage[],
  ): Promise<boolean> {
    const client = this.d.getClient();
    if (!client || this.d.state.lastKnownMessage?.sessionId !== sid) return false;
    const signal = this.d.state.connectionAbort?.signal;
    const rawNewer =
      prefetched ?? (await client.messagesNewerThan(sid, this.d.state.lastKnownMessage.id, undefined, signal).catch(() => undefined));
    if (rawNewer === undefined || stale()) return false;
    const [rawPermissions, rawForms] = await Promise.all([
      client.permissions(sid, signal).catch(() => [] as PermissionRequest[]),
      client.forms(sid, signal).catch(() => [] as FormRequest[]),
    ]);
    if (stale() || signal?.aborted) return true;
    const info = normalizeSessionInfo(rawInfo) ?? rawInfo;
    const newer = normalizeList(rawNewer, normalizeSessionMessage);
    const pending = await this.d.permissions.filterPending(client, sid, normalizeList(rawPermissions, normalizePermission));
    if (stale()) return true;
    const last = newer.at(-1);
    if (last) this.d.state.lastKnownMessage = { sessionId: sid, id: last.id };
    this.d.permissionActions.post();
    this.d.post({
      type: "sessionDelta",
      delta: {
        sessionId: sid,
        messages: newer,
        permissions: pending,
        forms: normalizeList(rawForms, normalizeForm),
        usage: info.tokens ? { cost: info.cost ?? 0, tokens: info.tokens } : undefined,
        busy: busyOverride ?? sessionIsBusy(info.time, newer),
        title: info.title,
        agent: info.agent,
        model: info.model,
      },
    });
    void this.d.refreshActions.refreshChanges().catch(() => {});
    void this.d.refreshActions.refreshInbox(sid).catch(() => {});
    return true;
  }

  /** Live stream has no replay: re-fetch the current session after a reconnect. */
  async resync(): Promise<void> {
    try {
      const generation = this.d.lifecycle.generations.load.current();
      // `resync()` is fire-and-forget from the stream status and view visibility handlers. Capture
      // the connection too: a folder switch or a new connect during the awaits below must not let an
      // old resync publish "connected" for a client we do not own.
      const connectGeneration = this.d.lifecycle.generations.connect.current();
      const client = this.d.getClient();
      const sid = this.d.state.sessionId;
      await this.d.refreshSessions();
      if (sid && sid === this.d.state.sessionId && client && client === this.d.getClient()) {
        const info = await client.getSession(sid);
        if (!this.d.lifecycle.generations.load.is(generation) || sid !== this.d.state.sessionId || client !== this.d.getClient()) return;
        const busyOverride = this.d.execution.isLocallyIdle(sid) ? false : undefined;
        const stale = () =>
          !this.d.lifecycle.generations.load.is(generation) || sid !== this.d.state.sessionId || client !== this.d.getClient();
        if (!(await this.resyncTail(sid, info, stale, busyOverride))) {
          await this.loadSession(info, stale, busyOverride);
        }
      }
      if (!this.d.lifecycle.generations.connect.is(connectGeneration) || client !== this.d.getClient()) return;
      if (this.d.state.status !== "error" || this.d.state.lastError?.kind === "connectionLost") this.d.setStatus("connected");
    } catch (err) {
      this.d.output.error(`[chat] resync failed: ${String(err)}`);
    }
  }

  /**
   * Manual sync from the header button: an authoritative reload from the server, meant to repair a
   * chat whose live state drifted. Unlike the visibility top-up, this rebuilds the webview state.
   * The completion notice is sent in `finally` so the button can never stay stuck on "syncing".
   */
  async syncNow(): Promise<void> {
    try {
      const client = this.d.getClient();
      const sid = this.d.state.sessionId;
      if (!client || !sid) return;
      const generation = this.d.lifecycle.generations.load.bump();
      const info = await client.getSession(sid);
      if (!this.d.lifecycle.generations.load.is(generation) || sid !== this.d.state.sessionId) return;
      await this.loadSession(info, () => !this.d.lifecycle.generations.load.is(generation) || sid !== this.d.state.sessionId);
    } finally {
      this.d.post({ type: "synced" });
    }
  }

  /**
   * The event stream is scoped to the host we connected to. Another client (e.g. the TUI
   * running as a separate process) writes sessions to the same on-disk storage but emits no event
   * on our stream, so its prompts are invisible until a manual Sync/Reconnect re-reads history.
   * Poll the open session's tail instead and fold new messages in through the same `sessionDelta`
   * path used on reconnect, so an external conversation shows up live while the chat is visible.
   */
  startLivePoll(): void {
    this.d.lifecycle.startInterval("livePoll", () => void this.pollSessionTail(), LIVE_POLL_MS);
  }

  stopLivePoll(): void {
    this.d.lifecycle.stopInterval("livePoll");
  }

  async pollSessionTail(force = false): Promise<void> {
    const client = this.d.getClient();
    const sid = this.d.state.sessionId;
    if (!client || !sid || this.d.state.status !== "connected" || (!force && !this.d.isVisible())) return;
    // Local turns are driven by live events; polling them would only re-post partial snapshots and
    // could pull a streaming card back to an older history state. Wait for the stream to go quiet.
    if (!force && Date.now() - this.d.state.lastSessionEventAt < LIVE_POLL_MS) return;
    const head = this.d.state.lastKnownMessage;
    if (!head || head.sessionId !== sid) return;
    try {
      const generation = this.d.lifecycle.generations.load.current();
      const stale = () => !this.d.lifecycle.generations.load.is(generation) || sid !== this.d.state.sessionId;
      // The tail itself is authoritative. `time.updated` is not a reliable gate: it can stay equal
      // on a coarse clock, or move for changes we do not render, which hides real messages.
      const newer = await client.messagesNewerThan(sid, head.id).catch(() => undefined);
      if (stale()) return;
      if (newer === undefined) {
        // `messagesNewerThan` looks at the newest page only. A burst of >200 messages from another
        // client (or a compacted history) has no overlap with our mark: fall back to a full load.
        // `getSession()` also gates transient tail failures — if the server is really down it throws
        // and the catch below logs, so a broken poll cannot rebuild the chat every two seconds.
        const info = await client.getSession(sid);
        if (stale()) return;
        await this.loadSession(info, stale, this.d.execution.isLocallyIdle(sid) ? false : undefined);
        void this.d.refreshSessions().catch(() => {});
        return;
      }
      if (newer.length === 0) return;
      const info = await client.getSession(sid);
      if (stale()) return;
      const busyOverride = this.d.execution.isLocallyIdle(sid) ? false : undefined;
      if (!(await this.resyncTail(sid, info, stale, busyOverride, newer))) {
        await this.loadSession(info, stale, busyOverride);
      }
      void this.d.refreshSessions().catch(() => {});
    } catch (err) {
      // A transient failure must not kill the poll: the next tick tries again.
      this.d.output.warn(`[chat] live poll failed: ${String(err)}`);
    }
  }

  /** Exposed for integration tests: run one poll now, independent of visibility and event quiet. */
  pollNow(): Promise<void> {
    return this.pollSessionTail(true);
  }

  /** Exposed for integration tests: force the reconnect-style resync without touching VS Code UI. */
  resyncNow(): Promise<void> {
    return this.resync();
  }

  scheduleReconcile(): void {
    const sid = this.d.state.sessionId;
    const generation = this.d.execution.generation.current();
    this.d.lifecycle.schedule(
      "reconcile",
      () => {
        if (!sid || sid !== this.d.state.sessionId || !this.d.execution.generation.is(generation)) return;
        void this.reconcileSession(sid, generation);
      },
      350,
    );
  }

  async reconcileSession(sid: string, generation: number): Promise<void> {
    const client = this.d.getClient();
    if (!client || sid !== this.d.state.sessionId) return;
    try {
      const info = await client.getSession(sid, this.d.state.connectionAbort?.signal);
      if (sid !== this.d.state.sessionId || !this.d.execution.generation.is(generation)) return;
      // If the composer was cleared locally and no new turn has started, the server's timestamps
      // are stale (a dismissed question can leave `busy` newer than `idle` with no idle message).
      // Keep it unlocked instead of re-syncing back to "stop".
      const busyOverride = this.d.execution.isLocallyIdle(sid) ? false : undefined;
      const stale = () => sid !== this.d.state.sessionId || !this.d.execution.generation.is(generation);
      if (!(await this.resyncTail(sid, info, stale, busyOverride))) {
        await this.loadSession(info, stale, busyOverride);
      }
    } catch (err) {
      // A failed reconcile is not worth surfacing: the live stream may still have delivered everything.
      this.d.output.warn(`[chat] session reconcile failed: ${String(err)}`);
    }
  }

  /**
   * `fast` is used by the first prompt: the user's text must reach the server without waiting for
   * catalog/session-list/diff round-trips. Those still run, but fire-and-forget with a generation
   * guard, so the webview is published as soon as history is available.
   */
  async loadSession(rawInfo: SessionInfo, stale?: () => boolean, busyOverride?: boolean, fast = false): Promise<void> {
    const client = this.d.getClient();
    if (!client || !this.d.state.folder) return;
    const signal = this.d.state.connectionAbort?.signal;
    const [rawMessages, rawPermissions, rawForms, rawInbox] = await Promise.all([
      // The other fetches degrade to empty lists; history must too. `send()` awaits loadSession
      // before posting, so a transient history error must not silently swallow the user's prompt.
      client.messages(rawInfo.id, 2000, signal).catch((err) => {
        this.d.output.warn(`[chat] could not load session history: ${String(err)}`);
        return [];
      }),
      client.permissions(rawInfo.id, signal).catch(() => []),
      client.forms(rawInfo.id, signal).catch(() => []),
      client.inbox(rawInfo.id, signal).catch(() => [] as InboxItem[]),
    ]);
    // A newer prompt may have started while history was loading; its events are fresher. An aborted
    // connection degraded every fetch to an empty list, which must not replace the transcript.
    if (stale?.() || signal?.aborted) return;
    this.d.observeContract({ messages: rawMessages, inbox: rawInbox });
    const info = normalizeSessionInfo(rawInfo) ?? rawInfo;
    const messages = normalizeList(rawMessages, normalizeSessionMessage);
    const forms = normalizeList(rawForms, normalizeForm);
    const changed = this.d.state.sessionId !== info.id;
    // Publish the new session before touching children: `loadSubagentSnapshot` captures the parent
    // synchronously and drops its result if that id does not match the open session. Setting it
    // afterwards made every subagent of a freshly selected session fail its own staleness guard.
    this.d.state.sessionId = info.id;
    if (changed) {
      this.d.subagents.reset();
      // Terminal events of the previous session cannot close its turn any more.
      this.d.execution.ensureSession(info.id);
    }
    const newest = messages.at(-1);
    this.d.state.lastKnownMessage = newest ? { sessionId: info.id, id: newest.id } : undefined;
    // Requests granted automatically must not linger as cards when the chat's toggle is on.
    const pending = await this.d.permissions.filterPending(client, info.id, normalizeList(rawPermissions, normalizePermission));
    // `filterPending` performs real HTTP calls (auto-approve). A session switch while it is in
    // flight bumps `loadGen`; without a second guard we would persist and post the stale session.
    if (stale?.()) return;
    await this.d.ctx.workspaceState.update(SESSION_KEY(this.d.state.folder.uri.toString()), info.id);
    // Persist the selection carried by the open session, so a reload without a session uses the
    // same model/agent. These are accepted values from the server, not an optimistic local choice.
    if (info.model && this.d.catalog.models.some((m) => m.id === info.model?.id && m.providerID === info.model?.providerID)) {
      this.d.catalog.selectModel(info.model);
    }
    if (info.agent && this.d.catalog.agents.some((a) => a.id === info.agent)) this.d.catalog.selectAgent(info.agent);
    if (!fast) {
      await this.refreshSlashItems();
      if (stale?.()) return;
    }
    this.d.catalog.publish();
    this.d.post({
      type: "session",
      session: {
        id: info.id,
        title: info.title,
        agent: info.agent,
        model: info.model,
        busy: busyOverride ?? sessionIsBusy(info.time, messages),
        messages,
        permissions: pending,
        forms,
        // Cost/tokens also come from history, so a resync must not clear the composer's meter.
        usage: info.tokens ? { cost: info.cost ?? 0, tokens: info.tokens } : undefined,
      },
    });
    // Past subagents have no live stream on a reload; load their history for the inline cards.
    // Track only after the `session` post: the webview clears its child state on a session switch,
    // so a snapshot posted first would be wiped by the very message that opens the new chat.
    for (const id of subagentSessionsFromMessages(messages)) this.d.subagents.track(id);
    // A running child has no id in its tool metadata; find it via `parentID` so a pending `ask`
    // permission is still answerable after the user switches back to this chat.
    void this.d.subagents.discover();
    this.d.permissionActions.post();
    this.d.refreshActions.publishInbox(rawInbox);
    if (fast) {
      // Not on the critical path of the first prompt. The generation guard keeps a late response
      // from overwriting state after a folder/session switch.
      const guard = stale;
      void this.refreshSlashItems().catch(() => {});
      void this.d.refreshSessions().catch(() => {});
      void this.d.refreshActions
        .refreshChanges()
        .then((diff) => {
          if (!guard?.()) this.d.observeContract({ diff });
        })
        .catch(() => {});
    } else {
      await this.d.refreshSessions();
      if (stale?.()) return;
      const diff = await this.d.refreshActions.refreshChanges();
      this.d.observeContract({ diff });
    }
    // Idempotent: a session opened without a connection change (e.g. after New Session + prompt)
    // still needs to follow turns started by other clients sharing the same on-disk storage.
    this.startLivePoll();
  }

  /**
   * One teardown path for "the current work does not matter". Callers otherwise repeat a different
   * subset of these steps in a different order; forgetting one was the source of stale-state races.
   */
  invalidateSessionState(): void {
    this.d.attention.clear();
    this.d.state.failedPrompt = undefined;
    this.d.lifecycle.generations.load.bump();
    this.d.abortConnectionRequests();
    this.d.clearTimers();
    this.stopLivePoll();
    this.d.state.lastKnownMessage = undefined;
    this.d.execution.reset();
  }
}
