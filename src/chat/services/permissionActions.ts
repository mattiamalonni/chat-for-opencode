import type { OpenCodeClient } from "../../client/http";
import type { PermissionRequest, ServerEvent } from "../../shared/api";
import type { HostMessage } from "../../shared/protocol";
import type { ControllerState } from "./controllerState";
import type { PermissionService } from "../permissionService";
import type { SubagentTracker } from "../subagentTracker";

/** Grants and auto-approval flows, owned by the chat rather than by a single session. */
export interface PermissionActionDeps {
  state: ControllerState;
  permissions: PermissionService;
  subagents: SubagentTracker;
  getClient(): OpenCodeClient | undefined;
  post(msg: HostMessage): void;
  postSessionEvent(sid: string, event: ServerEvent): void;
  log(line: string): void;
}

export class ChatPermissionActions {
  constructor(private readonly d: PermissionActionDeps) {}

  /** A child has no toggle of its own: it inherits the parent chat's choice. */
  enabled(): boolean {
    return this.d.permissions.enabled(this.d.state.sessionId);
  }

  post(): void {
    this.d.post({ type: "autoApprove", enabled: this.d.permissions.enabled(this.d.state.sessionId) });
  }

  async set(enabled: boolean): Promise<void> {
    const d = this.d;
    if (d.state.sessionId) await d.permissions.write(d.state.sessionId, enabled);
    else d.permissions.setPending(enabled);
    this.post();
    if (enabled) await this.approvePending();
  }

  async autoApprove(event: ServerEvent, sessionId: string): Promise<void> {
    const d = this.d;
    const request = event.data as PermissionRequest;
    const client = d.getClient();
    if (!client || !(await d.permissions.approveOnce(client, sessionId, request.id))) {
      // The grant failed: show the card in the session that owns the request, main chat or child.
      d.postSessionEvent(sessionId, event);
      return;
    }
    d.log(`[chat] auto-approved ${request.action} (${sessionId})`);
  }

  /** Grants requests that were already pending when auto-approval was turned on, in children too. */
  async approvePending(): Promise<void> {
    const d = this.d;
    const client = d.getClient();
    const sid = d.state.sessionId;
    if (!client || !sid || !this.enabled()) return;
    for (const id of [sid, ...d.subagents.ids()]) {
      const pending = await client.permissions(id).catch(() => [] as PermissionRequest[]);
      for (const request of pending) {
        if (!(await d.permissions.approveOnce(client, id, request.id))) {
          // The grant failed: make sure a card is shown instead of silently leaving the agent blocked.
          d.postSessionEvent(id, { type: "permission.asked", data: request });
        }
      }
    }
  }
}
