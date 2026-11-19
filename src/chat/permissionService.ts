import * as vscode from "vscode";
import type { OpenCodeClient } from "../client/http";
import type { PermissionRequest } from "../shared/api";

const AUTO_APPROVE_KEY = (folder: string) => `opencode.autoApprove:${folder}`;

interface StoredOverrides {
  [sessionId: string]: boolean;
}

/**
 * Owns everything about inline permissions: per-chat auto-approve preference, the set of requests
 * already granted automatically, and filtering stale requests out of a resynced session.
 */
export class PermissionService {
  private readonly autoApproved = new Set<string>();
  /** One shared result per request id, so concurrent callers cannot lose a failed reply. */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  /** Choice for a chat that has no session yet; `undefined` follows the setting. */
  private pending: boolean | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly folder: () => vscode.WorkspaceFolder | undefined,
    private readonly log: (line: string) => void,
  ) {}

  private key(): string | undefined {
    const folder = this.folder();
    return folder ? AUTO_APPROVE_KEY(folder.uri.toString()) : undefined;
  }

  /** Global default for chats that never toggled the setting. */
  defaultEnabled(): boolean {
    return vscode.workspace.getConfiguration("opencode", this.folder()?.uri).get<boolean>("autoApprovePermissions", false);
  }

  private overrides(): StoredOverrides {
    const key = this.key();
    return key ? this.ctx.workspaceState.get<StoredOverrides>(key) ?? {} : {};
  }

  enabled(sessionId?: string): boolean {
    if (!sessionId) return this.pending ?? this.defaultEnabled();
    return this.overrides()[sessionId] ?? this.defaultEnabled();
  }

  async write(sessionId: string, enabled: boolean | undefined): Promise<void> {
    const key = this.key();
    if (!key) return;
    const overrides = { ...this.overrides() };
    if (enabled === undefined) delete overrides[sessionId];
    else overrides[sessionId] = enabled;
    await this.ctx.workspaceState.update(key, overrides);
  }

  setPending(enabled: boolean | undefined): void {
    this.pending = enabled;
  }

  /** Consumes the pending choice when the first real session is created. */
  takePending(): boolean | undefined {
    const value = this.pending;
    this.pending = undefined;
    return value;
  }

  forgetRequest(requestId: string): void {
    this.autoApproved.delete(requestId);
  }

  /** Replies `once` so no rule is persisted; false means the card must be shown. */
  approveOnce(client: OpenCodeClient, sessionId: string, requestId: string): Promise<boolean> {
    const existing = this.inFlight.get(requestId);
    if (existing) return existing;
    if (this.autoApproved.has(requestId)) return Promise.resolve(true);
    // Store the promise, not just a marker: every caller must observe the *real* outcome. A failed
    // reply that was swallowed by a concurrent caller would leave the request pending with no card.
    const attempt = (async () => {
      try {
        await client.replyPermission(sessionId, requestId, "once");
        this.autoApproved.add(requestId);
        return true;
      } catch (err) {
        this.autoApproved.delete(requestId);
        this.log(`[chat] auto-approve failed for ${requestId}: ${String(err)}`);
        return false;
      } finally {
        this.inFlight.delete(requestId);
      }
    })();
    this.inFlight.set(requestId, attempt);
    return attempt;
  }

  /** Drops requests granted by auto-approval so stale cards do not reappear after a resync. */
  async filterPending(client: OpenCodeClient, sessionId: string, permissions: PermissionRequest[]): Promise<PermissionRequest[]> {
    if (permissions.length === 0 || !this.enabled(sessionId)) return permissions;
    const unresolved: PermissionRequest[] = [];
    for (const request of permissions) {
      if (!(await this.approveOnce(client, sessionId, request.id))) unresolved.push(request);
    }
    return unresolved;
  }
}
