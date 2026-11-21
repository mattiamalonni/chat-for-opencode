import * as vscode from "vscode";
import { OpenCodeClient, type Connection } from "../client/http";
import { EventStream } from "../client/sse";
import type { ConnectionStatus, UiError, UiErrorKind } from "../shared/protocol";
import { STRINGS } from "../shared/strings";
import type { Generation } from "./generation";
import { ExternalServer, type ServerHandle, type ServerState } from "../server/server";

/** The registry surface the supervisor needs (the concrete class lives in the controller). */
interface RegistryLike {
  get(folder: vscode.WorkspaceFolder): ServerHandle;
  reset(): Promise<void>;
}

/** Everything the supervisor needs from the controller, kept explicit instead of reaching back into it. */
export interface SupervisorHooks {
  registry: RegistryLike;
  log: (line: string) => void;
  getFolder: () => vscode.WorkspaceFolder | undefined;
  setFolder: (folder: vscode.WorkspaceFolder) => void;
  pickFolder: () => vscode.WorkspaceFolder | undefined;
  trustBlocked: () => boolean;
  postUntrusted: () => void;
  setStatus: (status: ConnectionStatus, error?: UiError) => void;
  getStatus: () => ConnectionStatus;
  generation: Generation;
  /** Install the connection (client, catalog, stream consumer, initial load) in the controller. */
  onReady: (conn: Connection, version: string | undefined, stale: () => boolean) => Promise<void>;
  onStreamReconnect: () => void;
  onDetached: () => void;
  toUiError: (err: unknown, fallback?: UiErrorKind) => UiError;
}

/**
 * Owns the server process handle, the HTTP client and the SSE stream: who we are connected to and
 * when that connection is stale. The controller keeps the chat-state work (`useConnection`,
 * `loadAll`, resync) and reacts through hooks, so connection ownership is no longer interleaved with
 * state publication in one 2,000-line class.
 */
export class ConnectionSupervisor {
  private server: ServerHandle | undefined;
  private serverSub: (() => void) | undefined;
  private client: OpenCodeClient | undefined;
  private stream: EventStream | undefined;
  private loadedConnection: Connection | undefined;
  private connecting: Promise<void> | undefined;
  private wasDisconnected = false;

  constructor(private readonly hooks: SupervisorHooks) {}

  get currentClient(): OpenCodeClient | undefined {
    return this.client;
  }

  get currentServer(): ServerHandle | undefined {
    return this.server;
  }

  get isExternal(): boolean {
    return this.server instanceof ExternalServer;
  }

  /** Installs a fresh client/stream for `conn`; the caller then runs the initial load. */
  openStream(conn: Connection, onEvent: (event: unknown) => void, onStreamStatus: (status: string, error?: unknown) => void): OpenCodeClient {
    this.stream?.close();
    this.client = new OpenCodeClient(conn);
    this.stream = new EventStream({
      url: this.client.eventUrl(),
      headers: this.client.headers(),
      onEvent,
      onStatus: onStreamStatus,
    });
    this.stream.start();
    return this.client;
  }

  closeStream(): void {
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
  }

  get isLoaded(): boolean {
    return this.loadedConnection !== undefined;
  }

  matches(conn: Connection): boolean {
    const loaded = this.loadedConnection;
    return !!loaded && this.client !== undefined &&
      this.client.conn.baseUrl === conn.baseUrl && this.client.conn.password === conn.password &&
      loaded.baseUrl === conn.baseUrl && loaded.password === conn.password;
  }

  markLoaded(conn: Connection): void {
    this.loadedConnection = { baseUrl: conn.baseUrl, password: conn.password };
  }

  clearLoaded(): void {
    this.loadedConnection = undefined;
  }

  isStale(token: number): boolean {
    return !this.hooks.generation.is(token);
  }

  /** Starts (or reuses) the server for the current folder and hands the connection to the controller. */
  connect(): Promise<void> {
    if (!this.connecting) {
      const pending = this.doConnect();
      this.connecting = pending;
      // Only clear our own entry: a newer connect started after an invalidation must survive the
      // completion of the one it replaced.
      const done = () => {
        if (this.connecting === pending) this.connecting = undefined;
      };
      void pending.then(done, done);
    }
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const token = this.hooks.generation.current();
    const stale = () => this.isStale(token);
    if (this.hooks.trustBlocked()) {
      this.hooks.postUntrusted();
      return;
    }
    if (!this.hooks.getFolder()) this.hooks.setFolder(this.hooks.pickFolder() as vscode.WorkspaceFolder);
    const folder = this.hooks.getFolder();
    if (!folder) {
      this.hooks.setStatus("error", {
        kind: "noWorkspace",
        message: vscode.l10n.t(STRINGS["error.noWorkspace"]),
        actions: ["openFolder"],
      });
      return;
    }
    const server = this.hooks.registry.get(folder);
    if (server !== this.server) {
      this.serverSub?.();
      this.server = server;
      this.serverSub = server.onDidChange((state) => this.onServerState(state, server));
    }
    this.hooks.setStatus("starting");
    try {
      const conn = await server.ensure();
      // A folder switch / reset / reconnect may have happened while `ensure()` was starting the
      // server. Installing that connection would bind the chat to the wrong (or disposed) server.
      if (stale()) return;
      await this.hooks.onReady(conn, server.state.status === "running" ? server.state.version : undefined, stale);
    } catch (err) {
      if (stale()) return;
      this.hooks.log(`[chat] connect failed: ${String(err)}`);
      this.hooks.setStatus("error", this.hooks.toUiError(err, "startFailed"));
    }
  }

  /** Restart the managed server and reload, invalidating the previous connection first. */
  async reconnect(): Promise<void> {
    this.hooks.generation.bump();
    this.connecting = undefined;
    const token = this.hooks.generation.current();
    const stale = () => this.isStale(token);
    if (!this.server) return this.connect();
    this.hooks.setStatus("starting");
    this.closeStream();
    this.clearLoaded();
    try {
      const conn = await this.server.restart();
      if (stale()) return;
      await this.hooks.onReady(conn, this.server.state.status === "running" ? this.server.state.version : undefined, stale);
    } catch (err) {
      if (stale()) return;
      this.hooks.setStatus("error", this.hooks.toUiError(err, "startFailed"));
    }
  }

  /** Unsubscribe from a folder's server without disposing the registry (used when switching folders). */
  detachServerOnly(): void {
    this.closeStream();
    this.clearLoaded();
    this.wasDisconnected = false;
    this.serverSub?.();
    this.serverSub = undefined;
    this.server = undefined;
  }

  /** Tear down the server/stream/client without binding a new connection. */
  async detach(): Promise<void> {
    this.hooks.generation.bump();
    this.connecting = undefined;
    this.closeStream();
    this.clearLoaded();
    this.wasDisconnected = false;
    this.serverSub?.();
    this.serverSub = undefined;
    this.server = undefined;
    await this.hooks.registry.reset();
    this.hooks.onDetached();
  }

  onServerState(state: ServerState, server?: ServerHandle): void {
    // A folder switch or reset can leave an in-flight notification from the previous server.
    if (server && server !== this.server) return;
    const token = this.hooks.generation.current();
    const stale = () => this.isStale(token);
    if (state.status === "starting" && this.hooks.getStatus() === "connected") {
      this.hooks.setStatus("reconnecting");
    } else if (
      state.status === "running" && this.client &&
      (this.client.conn.baseUrl !== state.conn.baseUrl || this.client.conn.password !== state.conn.password)
    ) {
      // The managed process was restarted: port *and* random password can change. Comparing only
      // the URL would leave a stale client on a reused port (endless 401s).
      void this.hooks.onReady(state.conn, state.version, stale).then(
        () => { if (!stale()) this.hooks.log("[chat] reconnected to restarted server"); },
        (err: unknown) => { if (!stale()) this.hooks.setStatus("error", this.hooks.toUiError(err)); },
      );
    } else if (state.status === "failed") {
      this.closeStream();
      this.hooks.setStatus("error", this.hooks.toUiError(state.error, "startFailed"));
    }
  }

  onStreamStatus(status: string, error?: unknown): void {
    if (status === "reconnecting") {
      this.hooks.log(`[events] disconnected: ${String(error ?? "stream ended")}`);
      if (this.hooks.getStatus() === "connected") this.hooks.setStatus("reconnecting");
      this.wasDisconnected = true;
      if (this.isExternal) {
        void this.client?.info().catch((err: unknown) => {
          if (this.hooks.getStatus() !== "error") {
            this.hooks.setStatus("reconnecting", {
              kind: "connectionLost",
              message: vscode.l10n.t(STRINGS["error.connectionLost"]),
              detail: String(err),
              actions: ["reconnect", "showLogs"],
            });
          }
        });
      }
    } else if (status === "connected" && this.wasDisconnected) {
      this.wasDisconnected = false;
      this.hooks.log("[events] reconnected, resyncing");
      this.hooks.onStreamReconnect();
    }
  }
}
