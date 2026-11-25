import type { OpenCodeClient } from "../../client/http";
import type { FileDiff, InboxItem } from "../../shared/api";
import { normalizeFileDiff, normalizeList } from "../../shared/adapter";
import type { HostMessage } from "../../shared/protocol";
import type { ControllerState } from "./controllerState";
import type { ChatLifecycle } from "../lifecycle";

/** Debounced refresh scheduling and the two read-only fetches triggered by it. */
export interface RefreshActionDeps {
  state: ControllerState;
  lifecycle: ChatLifecycle;
  getClient(): OpenCodeClient | undefined;
  post(msg: HostMessage): void;
  refreshSessions(): Promise<void>;
}

export class ChatRefreshActions {
  constructor(private readonly d: RefreshActionDeps) {}

  scheduleSessions(): void {
    this.d.lifecycle.schedule("sessions", () => void this.d.refreshSessions().catch(() => {}), 250);
  }

  scheduleChanges(): void {
    this.d.lifecycle.schedule("changes", () => void this.refreshChanges().catch(() => {}), 400);
  }

  /** Enqueue/deliver/cancel events arrive in bursts; one refresh per burst is enough. */
  scheduleInbox(): void {
    this.d.lifecycle.schedule("inbox", () => void this.refreshInbox().catch(() => {}), 150);
  }

  /**
   * Re-read the pending prompts from the server. A queued message is stored server-side, so the
   * webview cannot reconstruct the list from the event stream (which carries no replay).
   */
  async refreshInbox(sid = this.d.state.sessionId): Promise<void> {
    const d = this.d;
    const client = d.getClient();
    if (!client || !sid || sid !== d.state.sessionId) return;
    const items = await client.inbox(sid).catch(() => [] as InboxItem[]);
    if (sid !== d.state.sessionId || client !== d.getClient()) return;
    this.publishInbox(items);
  }

  publishInbox(items: InboxItem[]): void {
    this.d.post({ type: "inbox", items });
  }

  async refreshChanges(): Promise<FileDiff[]> {
    const d = this.d;
    const sid = d.state.sessionId;
    const client = d.getClient();
    let files: FileDiff[] = [];
    if (client && sid) {
      files = normalizeList(await client.diff(sid).catch(() => [] as FileDiff[]), normalizeFileDiff);
    }
    // The fetch is async: a session switch, new chat or folder change can happen while it is in
    // flight. Posting a diff fetched for the old session would overwrite the new chat's panel.
    if (sid !== d.state.sessionId || client !== d.getClient()) return files;
    d.post({ type: "changedFiles", files });
    return files;
  }
}
