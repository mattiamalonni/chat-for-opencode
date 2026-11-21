import type { OpenCodeClient } from "../client/http";
import type { FormRequest, PermissionRequest, ServerEvent, SessionInfo, SessionMessage } from "../shared/api";
import { sessionIsBusy } from "../shared/chatReducer";
import type { HostMessage } from "../shared/protocol";
import {
  normalizeForm,
  normalizeList,
  normalizePermission,
  normalizeSessionInfo,
  normalizeSessionMessage,
} from "../shared/adapter";
import type { Generation } from "./generation";

export interface SubagentCreated {
  parentId?: string;
  title?: string;
  agent?: string;
}

/**
 * Follows the child sessions spawned by the open chat: discovery, live-event routing and one-shot
 * history snapshots. The controller keeps only one-liners that delegate to it, so its `onEvent`
 * no longer interleaves subagent bookkeeping with session/permission logic.
 */
export class SubagentTracker {
  private readonly childSessions = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly pending = new Map<string, ServerEvent[]>();
  private static readonly MAX_CHILDREN = 30;

  constructor(
    private readonly client: () => OpenCodeClient | undefined,
    private readonly sessionId: () => string | undefined,
    private readonly folder: () => string | undefined,
    private readonly generation: Generation,
    private readonly post: (msg: HostMessage) => void,
    private readonly log: (line: string) => void,
    private readonly filterPending: (
      client: OpenCodeClient,
      childId: string,
      requests: PermissionRequest[],
      autoApprove: boolean,
    ) => Promise<PermissionRequest[]>,
    private readonly autoApproveEnabled: () => boolean,
  ) {}

  ids(): string[] {
    return [...this.childSessions];
  }

  hasChild(id: string): boolean {
    return this.childSessions.has(id);
  }

  /** Whether an id is the current session or one of its (possibly nested) child sessions. */
  isTracked(id: string): boolean {
    if (id === this.sessionId()) return true;
    let parent = this.parents.get(id);
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === this.sessionId()) return true;
      seen.add(parent);
      parent = this.parents.get(parent);
    }
    return false;
  }

  reset(): void {
    this.generation.bump();
    this.childSessions.clear();
    this.parents.clear();
    this.pending.clear();
  }

  setParent(id: string, parentId: string): void {
    this.parents.set(id, parentId);
  }

  forget(id: string): void {
    this.childSessions.delete(id);
    this.parents.delete(id);
    this.pending.delete(id);
  }

  /** Route a live event to the chat or to a child view, buffering it until its snapshot arrives. */
  postEvent(sid: string, event: ServerEvent): void {
    if (sid === this.sessionId()) {
      this.post({ type: "event", event });
      return;
    }
    const buffered = this.pending.get(sid);
    if (buffered) {
      if (buffered.length < 500) buffered.push(event);
    } else if (this.childSessions.has(sid)) {
      this.post({ type: "subagentEvent", sessionId: sid, event });
    }
  }

  /** Begin following a child id seen in tool metadata or in a `session.created` event. */
  track(childId: string, created?: SubagentCreated): void {
    const parent = this.sessionId();
    if (!parent || childId === parent || this.childSessions.has(childId)) return;
    if (this.childSessions.size >= SubagentTracker.MAX_CHILDREN) {
      const oldest = this.childSessions.values().next().value;
      if (oldest) this.forget(oldest);
    }
    this.childSessions.add(childId);
    this.pending.set(childId, []);
    if (created?.parentId) this.parents.set(childId, created.parentId);
    void this.snapshot(childId, created);
  }

  /** A running child has no id in its tool state yet; discover it from the session list. */
  async discover(): Promise<void> {
    const client = this.client();
    const sid = this.sessionId();
    const directory = this.folder();
    if (!client || !sid || !directory) return;
    const token = this.generation.current();
    const children = await client.listChildSessions(sid, directory).catch(() => [] as SessionInfo[]);
    if (!this.generation.is(token) || sid !== this.sessionId()) return;
    for (const info of children) {
      if (info.time.archived || this.childSessions.has(info.id)) continue;
      this.track(info.id, { parentId: sid, title: info.title, agent: info.agent });
    }
  }

  /** One history fetch on discovery makes the child view complete even after a reconnect. */
  async snapshot(childId: string, created?: SubagentCreated): Promise<void> {
    const client = this.client();
    const parent = this.sessionId();
    if (!client || !parent) return;
    const token = this.generation.current();
    const bestEffort = <T>(label: string, promise: Promise<T>, fallback: T): Promise<T> =>
      promise.catch((err) => {
        this.log(`[chat] ${label} failed: ${String(err)}`);
        return fallback;
      });
    const [info, rawMessages, rawPermissions, rawForms] = await Promise.all([
      bestEffort("subagent session", client.getSession(childId), undefined as SessionInfo | undefined),
      bestEffort("subagent history", client.messages(childId), [] as SessionMessage[]),
      bestEffort("subagent permissions", client.permissions(childId), [] as PermissionRequest[]),
      bestEffort("subagent forms", client.forms(childId), [] as FormRequest[]),
    ]);
    if (!this.generation.is(token) || parent !== this.sessionId()) return;
    const safe = normalizeSessionInfo(info) ?? info;
    const messages = normalizeList(rawMessages, normalizeSessionMessage);
    // A live event may have been granted while this snapshot was in flight: pass the decision
    // explicitly so a child (which has no override) cannot resurrect an already-granted card.
    const permissions = await this.filterPending(
      client,
      childId,
      normalizeList(rawPermissions, normalizePermission),
      this.autoApproveEnabled(),
    );
    if (!this.generation.is(token) || parent !== this.sessionId()) return;
    this.post({
      type: "subagent",
      snapshot: {
        sessionId: childId,
        parentId: safe?.parentID ?? created?.parentId ?? this.parents.get(childId),
        title: created?.title ?? safe?.title,
        agent: created?.agent ?? safe?.agent,
        messages,
        permissions,
        forms: normalizeList(rawForms, normalizeForm),
        busy: safe ? sessionIsBusy(safe.time, messages) : true,
      },
    });
    // The snapshot replaces the child's webview state; replay everything received while it loaded.
    const buffered = this.pending.get(childId) ?? [];
    this.pending.delete(childId);
    for (const event of buffered) this.post({ type: "subagentEvent", sessionId: childId, event });
  }
}
