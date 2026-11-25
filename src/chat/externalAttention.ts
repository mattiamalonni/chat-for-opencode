import type { FormRequest, PermissionRequest, ServerEvent } from "../shared/api";
import { asForm, asPermission } from "../shared/chatReducer/helpers";
import type { ExternalAttentionItem, HostMessage } from "../shared/protocol";

const MAX_EXTERNAL_REQUESTS = 50;

interface Entry {
  sessionId: string;
  label?: string;
  permission?: PermissionRequest;
  question?: FormRequest;
  seq: number;
}

const dataOf = (event: ServerEvent): Record<string, unknown> =>
  event.data && typeof event.data === "object" && !Array.isArray(event.data) ? (event.data as Record<string, unknown>) : {};

/**
 * Keeps the pending requests of sessions that are neither the open chat nor tracked subagents.
 * Those events reach the extension over the shared event stream but the normal router sends them
 * nowhere (there is no view for them), so a turn started in the TUI could block with no way to
 * answer it here. The cards use the request's own session id, so replying is unchanged.
 *
 * The map is bounded and keyed by request id: a resync or a duplicate event replaces an entry,
 * never stacks a second card.
 */
export class ExternalAttentionService {
  private readonly byId = new Map<string, Entry>();
  private seq = 0;

  constructor(
    private readonly post: (msg: HostMessage) => void,
    private readonly labelOf: (sid: string) => string | undefined,
  ) {}

  /** Called for every normalized server event, before the router decides who owns it. */
  observe(event: ServerEvent, sid: string | undefined, isCurrent: boolean, isChild: boolean): void {
    if (event.type === "permission.replied" || event.type === "form.replied" || event.type === "form.cancelled") {
      const id = event.type === "permission.replied" ? dataOf(event).requestID : dataOf(event).id;
      if (typeof id === "string" && this.byId.delete(id)) this.publish();
      return;
    }
    if (event.type === "session.deleted" && sid) {
      if (this.forget(sid)) return;
    }
    // The open chat and tracked children already render their own cards; showing a copy here
    // would let the same request be answered twice.
    if (!sid || isCurrent || isChild) return;
    if (event.type === "permission.asked") {
      const permission = asPermission(event.data);
      if (!permission) return;
      this.set(permission.id, { sessionId: sid, label: this.labelOf(sid), permission });
    } else if (event.type === "form.created") {
      const question = asForm(dataOf(event).form);
      if (!question) return;
      this.set(question.id, { sessionId: sid, label: this.labelOf(sid), question });
    }
  }

  /** Drop every request belonging to a session. Returns true when something changed. */
  forget(sid: string): boolean {
    let changed = false;
    for (const [id, entry] of this.byId) {
      if (entry.sessionId === sid) changed = this.byId.delete(id) || changed;
    }
    if (changed) this.publish();
    return changed;
  }

  /** Folder switches and reconnects own a different server; old requests cannot be answered. */
  reset(): void {
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.publish();
  }

  private set(id: string, entry: Omit<Entry, "seq">): void {
    this.byId.set(id, { ...entry, seq: ++this.seq });
    while (this.byId.size > MAX_EXTERNAL_REQUESTS) {
      const oldest = [...this.byId.entries()].sort((a, b) => a[1].seq - b[1].seq)[0];
      this.byId.delete(oldest[0]);
    }
    this.publish();
  }

  private publish(): void {
    const items: ExternalAttentionItem[] = [...this.byId.values()]
      .sort((a, b) => a.seq - b.seq)
      .map(({ sessionId, label, permission, question }) => ({
        sessionId,
        ...(label ? { label } : {}),
        ...(permission ? { permission } : {}),
        ...(question ? { question } : {}),
      }));
    this.post({ type: "externalAttention", items });
  }
}
