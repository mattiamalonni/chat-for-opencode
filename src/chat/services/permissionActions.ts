import type { OpenCodeClient } from "../../client/http";
import type { PermissionRequest, ServerEvent, SessionInfo } from "../../shared/api";
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
  getDirectory(): string | undefined;
  post(msg: HostMessage): void;
  postSessionEvent(sid: string, event: ServerEvent): void;
  postExternal(event: ServerEvent, sid: string): void;
  forgetExternalRequest(requestId: string): void;
  log(line: string): void;
}

export class ChatPermissionActions {
  constructor(private readonly d: PermissionActionDeps) {}

  /** The toggle is workspace-wide, so every session in this folder follows the same choice. */
  enabled(): boolean {
    return this.d.permissions.enabled();
  }

  post(): void {
    this.d.post({ type: "autoApprove", enabled: this.enabled() });
  }

  async set(enabled: boolean): Promise<void> {
    await this.d.permissions.write(enabled);
    this.post();
    if (enabled) await this.approvePending();
  }

  async autoApprove(event: ServerEvent, sessionId: string, onFailure?: () => void): Promise<void> {
    const d = this.d;
    const request = event.data as PermissionRequest;
    const client = d.getClient();
    if (!client || !(await d.permissions.approveOnce(client, sessionId, request.id))) {
      // The grant failed: make sure a card is shown instead of silently leaving the agent blocked.
      if (onFailure) onFailure();
      else d.postSessionEvent(sessionId, event);
      return;
    }
    d.forgetExternalRequest(request.id);
    d.log(`[chat] auto-approved ${request.action} (${sessionId})`);
  }

  /** Grants requests already pending when auto-approval was turned on, in every session of the workspace. */
  async approvePending(): Promise<void> {
    const d = this.d;
    const client = d.getClient();
    const directory = d.getDirectory();
    if (!client || !directory || !this.enabled()) return;
    const ids = new Set<string>();
    if (d.state.sessionId) ids.add(d.state.sessionId);
    for (const id of d.subagents.ids()) ids.add(id);
    const sessions = await client.listSessions(directory, 100).catch(() => [] as SessionInfo[]);
    for (const session of sessions) if (session.id) ids.add(session.id);
    for (const id of ids) {
      const pending = await client.permissions(id).catch(() => [] as PermissionRequest[]);
      for (const request of pending) {
        if (await d.permissions.approveOnce(client, id, request.id)) {
          d.forgetExternalRequest(request.id);
        } else {
          // The grant failed: show the card where the request can actually be answered.
          if (id === d.state.sessionId || d.subagents.isTracked(id)) d.postSessionEvent(id, { type: "permission.asked", data: request });
          else d.postExternal({ type: "permission.asked", data: request }, id);
        }
      }
    }
  }
}
