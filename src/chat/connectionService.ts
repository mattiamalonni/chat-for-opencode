import * as vscode from "vscode";
import type { Connection } from "../client/http";
import type { ServerEvent } from "../shared/api";
import type { HostMessage } from "../shared/protocol";
import type { CatalogService } from "./catalogService";
import type { ControllerState } from "./controllerState";
import { SESSION_KEY } from "./storageKeys";
import { FileIndex } from "./context";
import type { ChatViews } from "./views";
import type { Generation } from "./generation";
import type { ChatLifecycle } from "./lifecycle";
import type { PermissionService } from "./permissionService";
import type { SessionListService } from "./sessionListService";
import type { SubagentTracker } from "./subagentTracker";
import type { ConnectionSupervisor } from "./connectionSupervisor";
import type { ChatPermissionActions } from "./permissionActions";
import type { ChatRefreshActions } from "./refreshActions";
import type { ChatSessionService } from "./sessionService";
import type { ServerHandle, ServerState } from "../server/server";

export interface ConnectionServiceDeps {
  state: ControllerState;
  ctx: vscode.ExtensionContext;
  supervisor: ConnectionSupervisor;
  lifecycle: ChatLifecycle;
  catalog: CatalogService;
  subagents: SubagentTracker;
  permissions: PermissionService;
  sessionList: SessionListService;
  chatViews: ChatViews;
  deleteGeneration: Generation;
  sessionService: ChatSessionService;
  permissionActions: ChatPermissionActions;
  refreshActions: ChatRefreshActions;
  getFileIndex(): FileIndex | undefined;
  setFileIndex(index: FileIndex | undefined): void;
  postInit(): void;
  post(msg: HostMessage): void;
  onEvent(event: ServerEvent): void;
  postUntrusted(): void;
  trustBlocked(): boolean;
  setStatus(status: "idle" | "starting" | "connected" | "reconnecting" | "error"): void;
  refreshSessions(): Promise<void>;
}

/** Server connection lifecycle, folder switching and teardown. */
export class ChatConnectionService {
  constructor(private readonly d: ConnectionServiceDeps) {}

  abortConnectionRequests(): void {
    this.d.state.connectionAbort?.abort();
    this.d.state.connectionAbort = undefined;
  }

  /**
   * Host-side execution state, for the status bar and completion notifications. Deliberately
   * separate from `post()`: the webview already receives events, the editor chrome does not.
   */

  async onWorkspaceTrustChanged(trusted: boolean): Promise<void> {
    if (trusted) {
      if (this.d.chatViews.hasPrimary) await this.connect();
      return;
    }
    await this.detachServers();
    this.d.postUntrusted();
  }

  /** Starts (or reuses) the server for the current folder and loads everything. */
  connect(): Promise<void> {
    return this.d.supervisor.connect();
  }

  /** Integration-test hook for late server notifications (see extension.test.ts). */
  onServerState(state: ServerState, server?: ServerHandle): void {
    this.d.supervisor.onServerState(state, server);
  }

  /**
   * Installs a connection owned by the supervisor, then loads chat state from it. A failed load
   * leaves the client installed but *not* marked loaded, so the next reconnect retries instead of
   * hitting the "same connection" no-op guard.
   */
  async useConnection(conn: Connection, isStale: () => boolean = () => false): Promise<void> {
    if (isStale()) return;
    if (this.d.trustBlocked()) {
      this.d.postUntrusted();
      return;
    }
    if (this.d.supervisor.matches(conn)) return;
    this.d.supervisor.clearLoaded();
    // Every fetch below belongs to this connection; a later folder/session change must cancel it.
    this.abortConnectionRequests();
    this.d.state.connectionAbort = new AbortController();
    this.d.catalog.resetWarmUp();
    this.d.getFileIndex()?.dispose();
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.d.setFileIndex(folders.length > 0 ? new FileIndex(folders, this.d.ctx.workspaceState) : undefined);
    this.d.supervisor.openStream(
      conn,
      (event) => this.d.onEvent(event as ServerEvent),
      (status, error) => this.d.supervisor.onStreamStatus(status, error),
    );
    await this.d.sessionService.loadAll();
    this.d.supervisor.markLoaded(conn);
    this.d.sessionService.startLivePoll();
  }

  clearTimers(): void {
    this.d.lifecycle.clearAll();
    this.d.state.catalogRetries = 0;
  }

  /** Drafts live in workspaceState so they survive a window reload (vscode.setState does not). */

  /** Grants requests that were already pending when auto-approval was turned on, in children too. */

  /** Enqueue/deliver/cancel events arrive in bursts; one refresh per burst is enough. */

  /**
   * Re-read the pending prompts from the server. A queued message is stored server-side, so the
   * webview cannot reconstruct the list from the SSE events (which carry no replay).
   */

  /**
   * The event stream is live-only, so a missed terminal event can leave the webview showing an
   * incomplete turn forever. After each turn, re-read the session and replace the webview state.
   * Skipped when another prompt starts meanwhile, since its live events are newer than the snapshot.
   */

  invalidateConnection(): void {
    this.d.lifecycle.generations.connect.bump();
    this.d.lifecycle.generations.sessions.bump();
    // A bulk delete belongs to one folder/connection; a new session within the same connection must
    // not cancel it (server events can legitimately open a session while the walk is in progress).
    this.d.deleteGeneration.bump();
    this.d.state.deleteAllAbort?.abort();
    this.d.sessionList.reset();
    this.d.sessionList.cancelSearch();
    this.d.sessionService.invalidateSessionState();
  }

  async newSession(): Promise<void> {
    this.d.sessionService.invalidateSessionState();
    // No session is open any more: polling its tail would be a no-op every two seconds until the
    // next load. Loading that session starts the poll again.
    this.d.state.sessionId = undefined;
    this.d.subagents.reset();
    if (this.d.state.folder) await this.d.ctx.workspaceState.update(SESSION_KEY(this.d.state.folder.uri.toString()), undefined);
    this.d.post({ type: "session", session: null });
    this.d.post({ type: "changedFiles", files: [] });
    this.d.refreshActions.publishInbox([]);
    this.d.permissionActions.post();
    this.d.catalog.publish();
    await this.d.refreshSessions().catch(() => {});
    this.d.post({ type: "focusInput" });
  }

  async reconnect(): Promise<void> {
    if (this.d.trustBlocked()) {
      this.d.postUntrusted();
      return;
    }
    this.d.sessionService.invalidateSessionState();
    await this.d.supervisor.reconnect();
  }

  /** Tears down the server/stream/client without binding a new connection. */
  async detachServers(): Promise<void> {
    this.invalidateConnection();
    await this.d.supervisor.detach();
  }

  async resetServers(): Promise<void> {
    await this.detachServers();
    if (this.d.chatViews.hasPrimary) await this.connect();
  }

  /** The "Stop Server" command: stop for good, no immediate reconnect. The next prompt reconnects. */
  async stopServer(): Promise<void> {
    await this.detachServers();
    this.d.setStatus("idle");
  }

  async switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (folder?.uri.toString() === this.d.state.folder?.uri.toString()) return;
    this.invalidateConnection();
    this.d.state.sessionId = undefined;
    // Detach the old server before connecting to the new folder: its late state notifications must
    // not race the new connection (the supervisor still re-checks ownership when it installs one).
    this.d.supervisor.detachServerOnly();
    this.d.state.folder = folder;
    this.d.postInit();
    this.d.post({ type: "session", session: null });
    this.d.post({ type: "changedFiles", files: [] });
    this.d.permissionActions.post();
    await this.connect();
  }
}
