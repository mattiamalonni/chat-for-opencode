import * as vscode from "vscode";
import type { OpenCodeClient } from "../client/http";
import type { PermissionRequest } from "../shared/api";

const AUTO_APPROVE_KEY = (folder: string) => `opencode.autoApprove:${folder}`;

/** Request ids are only unique within a session; compose both so restarts/replays cannot collide. */
const requestKey = (sessionId: string, requestId: string) => `${sessionId}:${requestId}`;

/** A reply event can be missed on a reconnect, so granted ids may linger; keep the set bounded. */
const MAX_AUTO_APPROVED = 500;

interface StoredOverrides {
  [sessionId: string]: boolean;
}

/**
 * Owns everything about inline permissions: per-chat auto-approve preference, the set of requests
 * already granted automatically, and filtering stale requests out of a resynced session.
 */
export class PermissionService {
  private readonly autoApproved = new Set<string>();
  /** One shared result per (session, request) pair, so concurrent callers cannot lose a failed reply. */
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

  /**
   * Forgets a request after a reply. Without a `sessionId` (the `permission.replied` event does not
   * carry one) every session's entry for that request id is removed.
   */
  forgetRequest(requestId: string, sessionId?: string): void {
    if (sessionId !== undefined) {
      const key = requestKey(sessionId, requestId);
      this.autoApproved.delete(key);
      this.inFlight.delete(key);
      return;
    }
    const suffix = `:${requestId}`;
    for (const key of this.autoApproved) {
      if (key.endsWith(suffix)) this.autoApproved.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.endsWith(suffix)) this.inFlight.delete(key);
    }
  }

  /** Replies `once` so no rule is persisted; false means the card must be shown. */
  approveOnce(client: OpenCodeClient, sessionId: string, requestId: string): Promise<boolean> {
    const key = requestKey(sessionId, requestId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.autoApproved.has(key)) return Promise.resolve(true);
    // Store the promise, not just a marker: every caller must observe the *real* outcome. A failed
    // reply that was swallowed by a concurrent caller would leave the request pending with no card.
    const attempt = (async () => {
      try {
        await client.replyPermission(sessionId, requestId, "once");
        this.autoApproved.add(key);
        // FIFO eviction: the oldest grant is the least likely to still be re-synced as a card.
        if (this.autoApproved.size > MAX_AUTO_APPROVED) {
          const oldest = this.autoApproved.values().next().value;
          if (oldest !== undefined) this.autoApproved.delete(oldest);
        }
        return true;
      } catch (err) {
        this.autoApproved.delete(key);
        this.log(`[chat] auto-approve failed for ${key}: ${String(err)}`);
        return false;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, attempt);
    return attempt;
  }

  /**
   * Drops requests granted by auto-approval so stale cards do not reappear after a resync.
   * `approved` overrides the gate for callers that already resolved it in another session's
   * context (a subagent inherits its parent's per-chat choice but has no override of its own);
   * `sessionId` is still the session the reply is addressed to.
   */
  async filterPending(
    client: OpenCodeClient,
    sessionId: string,
    permissions: PermissionRequest[],
    approved = this.enabled(sessionId),
  ): Promise<PermissionRequest[]> {
    if (permissions.length === 0 || !approved) return permissions;
    const unresolved: PermissionRequest[] = [];
    for (const request of permissions) {
      if (!(await this.approveOnce(client, sessionId, request.id))) unresolved.push(request);
    }
    return unresolved;
  }
}
