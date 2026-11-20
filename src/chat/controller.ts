import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ApiError, OpenCodeClient, type PermissionRule } from "../client/http";
import { EventStream } from "../client/sse";
import { CatalogService } from "./catalogService";
import { FileIconThemeService, type LanguageContribution } from "./fileIconTheme";
import { Generation } from "./generation";
import { ExternalServer, ManagedServer, ServerError, type ServerHandle, type ServerState } from "../server/server";
import type {
  AgentInfo,
  FileAttachment,
  FileDiff,
  FormRequest,
  ModelInfo,
  PermissionRequest,
  ServerEvent,
  SessionInfo,
  SessionMessage,
} from "../shared/api";
import {
  normalizeFileDiff,
  normalizeForm,
  normalizeList,
  normalizePermission,
  normalizeServerEvent,
  normalizeSessionInfo,
  normalizeSessionMessage,
} from "../shared/adapter";
import { eventSessionId, sessionIsBusy, sessionLooksBusy, toSessionSummary } from "../shared/chatReducer";
import { parseSubagentReport } from "../shared/subagentReport";
import { checkCompatibility } from "../shared/compatibility";
import { checkContract, contractSignature, emptyContract, type ContractObservations } from "../shared/contract";
import type {
  ActionId,
  Attachment,
  ConnectionStatus,
  ContextItem,
  DroppedFile,
  HostMessage,
  SessionSummary,
  UiError,
  UiErrorKind,
  WebviewMessage,
} from "../shared/protocol";
import { STRINGS, type Strings } from "../shared/strings";
import { MAX_ATTACHMENT_BYTES, resolveAttachment } from "./attachments";
import { ContextTracker, FileIndex, selectionAttachment } from "./context";
import { DiffService } from "./diff";
import { DEFAULT_SESSION_PERMISSIONS } from "./permissions";
import { PermissionService } from "./permissionService";

const PASSWORD_KEY = (endpoint: string) => `opencode.password:${endpoint}`;
const SESSION_KEY = (folder: string) => `opencode.session:${folder}`;
const COMPAT_DISMISSED_KEY = "opencode.compatibilityDismissedFor";
const CONTRACT_DISMISSED_KEY = "opencode.contractDismissedFor";
const DRAFTS_KEY = (folder: string) => `opencode.drafts:${folder}`;

/**
 * How often an open session is re-read from history. The SSE stream only carries events from the
 * server process we connected to: a prompt typed in the TUI (or any other client sharing the
 * on-disk session storage) never reaches it, so history is the only way to see it live.
 */
const LIVE_POLL_MS = 2000;

const ATTACHMENT_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function mimeFromName(name: string): string {
  return ATTACHMENT_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Quotes a single argument for a shell command sent to an interactive terminal. `executablePath`
 * is machine-overridable, so it can come from a workspace's settings: concatenating it into a
 * command line unsafely would let that workspace run arbitrary commands when the user clicks
 * "Sign in". POSIX uses single quotes (with the usual `'\''` escape); cmd.exe has no safe way to
 * embed a double quote, so such paths are rejected instead.
 */
function quoteForShell(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("The executable path contains a control character.");
  if (process.platform === "win32") {
    if (/["&|<>^%!]/.test(value)) throw new Error('The executable path contains a character cmd.exe cannot quote safely (", &, |, <, >, ^, %, !).');
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Child ids recorded in the tool state of a loaded session's history. */
function subagentSessionsFromMessages(messages: SessionMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const part of m.content) {
      if (part.type !== "tool" || (part.name !== "subagent" && part.name !== "task")) continue;
      const id = (part.state as { metadata?: { sessionID?: unknown } }).metadata?.sessionID;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

let cachedStrings: Strings | undefined;
/** Locale and the string table are static for a session: translate once, not on every error/reconnect. */
export function translatedStrings(): Strings {
  return (cachedStrings ??= Object.fromEntries(
    Object.entries(STRINGS).map(([k, v]) => [k, vscode.l10n.t(v)]),
  ) as Strings);
}

/** One server per workspace folder, created lazily. */
export class ServerRegistry implements vscode.Disposable {
  private readonly servers = new Map<string, ServerHandle>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (line: string) => void,
    private readonly recordsDir: string,
  ) {}

  get(folder: vscode.WorkspaceFolder): ServerHandle {
    const key = folder.uri.toString();
    let server = this.servers.get(key);
    if (!server) {
      const cfg = vscode.workspace.getConfiguration("opencode", folder.uri);
      const endpoint = cfg.get<string>("endpoint", "").trim();
      server = endpoint
        ? new ExternalServer({
            folder: folder.uri.fsPath,
            endpoint,
            getPassword: async () => this.secrets.get(PASSWORD_KEY(endpoint)),
            log: this.log,
          })
        : new ManagedServer({
            folder: folder.uri.fsPath,
            executable: cfg.get<string>("executablePath", "opencode").trim() || "opencode",
            startupTimeoutMs: cfg.get<number>("startupTimeout", 30_000),
            autoRestart: cfg.get<boolean>("autoRestart", true),
            log: this.log,
            recordsDir: this.recordsDir,
          });
      this.servers.set(key, server);
    }
    return server;
  }

  async reset(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => s.dispose()));
  }

  async dispose(): Promise<void> {
    await this.reset();
  }
}

function toUiError(err: unknown, fallback: UiErrorKind = "requestFailed"): UiError {
  const s = translatedStrings();
  if (err instanceof ServerError) {
    switch (err.kind) {
      case "notInstalled":
        return { kind: "notInstalled", message: s["error.notInstalled"], detail: err.detail ?? err.message, actions: ["install", "openSettings", "showLogs"] };
      case "unauthorized":
        return { kind: "unauthorized", message: s["error.unauthorized"], detail: err.message, actions: ["setPassword", "openSettings"] };
      case "unreachable":
        return { kind: "connectionLost", message: s["error.connectionLost"], detail: err.detail ?? err.message, actions: ["reconnect", "openSettings", "showLogs"] };
      default:
        return { kind: "startFailed", message: s["error.startFailed"], detail: [err.message, err.detail].filter(Boolean).join("\n"), actions: ["reconnect", "showLogs", "openSettings"] };
    }
  }
  if (err instanceof ApiError && err.status === 401) {
    return { kind: "unauthorized", message: s["error.unauthorized"], detail: err.message, actions: ["setPassword", "reconnect"] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: fallback, message: s[`error.${fallback}`], detail: message, actions: ["reconnect", "showLogs"] };
}

export class ChatController implements vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private folder: vscode.WorkspaceFolder | undefined;
  private server: ServerHandle | undefined;
  private serverSub: (() => void) | undefined;
  private client: OpenCodeClient | undefined;
  private stream: EventStream | undefined;
  private sessionId: string | undefined;
  private status: ConnectionStatus = "idle";
  private lastError: UiError | undefined;
  private version: string | undefined;
  private contractObservations: ContractObservations = {};
  private contract = emptyContract;
  /** Server-provided catalog and the user's model/agent selection. */
  private readonly catalog: CatalogService;
  /** File icons come from the user's active icon theme, resolved on demand for the webview. */
  private readonly fileIcons: FileIconThemeService;
  private fileIndex: FileIndex | undefined;
  private readonly context: ContextTracker;
  private readonly disposables: vscode.Disposable[] = [];
  /** Inline permissions: per-chat auto-approve, granted ids and pending-request filtering. */
  private readonly permissions: PermissionService;
  private sessionsTimer: NodeJS.Timeout | undefined;
  /** Invalidates in-flight session refreshes when a newer one starts or the folder changes. */
  private readonly sessionsGen = new Generation();
  private sessionsCursor: string | undefined;
  private sessionsHasMore = false;
  private sessionsLoadingMore = false;
  private sessionItems: SessionSummary[] = [];
  private changesTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private readonly executionGen = new Generation();
  /**
   * Last locally-posted idle status. A resync before the next turn must not re-lock the composer
   * with stale server timestamps (e.g. a dismissed question leaves `busy` newer than `idle`).
   */
  private localIdle: { sid: string; generation: number } | undefined;
  /** Invalidates an in-flight session load when a newer session/folder wins the race. */
  private readonly loadGen = new Generation();
  /** High-water mark for incremental resync: the newest history message id of the loaded session. */
  private lastKnownMessage: { sessionId: string; id: string } | undefined;
  /** Periodic history poll that picks up changes made by other clients (TUI, CLI, …). */
  private livePollTimer: NodeJS.Timeout | undefined;
  /** Last live SSE event for the open session; a poll is redundant while the stream feeds us. */
  private lastSessionEventAt = 0;
  private connecting: Promise<void> | undefined;
  /** Invalidates a `doConnect()` whose `ensure()` was still in flight when the folder/server changed. */
  private readonly connectGen = new Generation();
  private wasDisconnected = false;
  /** Child sessions spawned by `subagent` tools of the current session (nested ones included). */
  private readonly childSessions = new Set<string>();
  /** Parent id per child, so nested subagents can be followed back to the current session. */
  private readonly sessionParents = new Map<string, string>();
  /** Invalidates an in-flight child history fetch after a session/folder switch. */
  private readonly childGen = new Generation();
  /** Live child events held until the history snapshot is posted, so nothing is overwritten. */
  private readonly pendingChildEvents = new Map<string, ServerEvent[]>();
  private static readonly MAX_CHILD_SESSIONS = 30;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly registry: ServerRegistry,
    private readonly diffs: DiffService,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.context = new ContextTracker((items) => this.post({ type: "context", items }));
    this.permissions = new PermissionService(ctx, () => this.folder, (line) => output.info(line));
    this.catalog = new CatalogService(ctx, (msg) => this.post(msg), (line) => output.info(line), () => !!this.view);
    this.fileIcons = new FileIconThemeService({
      themeId: () => vscode.workspace.getConfiguration("workbench").get<string | null>("iconTheme") ?? undefined,
      variant: () => {
        const kind = vscode.window.activeColorTheme.kind;
        if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) return "highContrast";
        return kind === vscode.ColorThemeKind.Light ? "light" : "dark";
      },
      associations: () => vscode.workspace.getConfiguration("files", this.folder?.uri).get<Record<string, string>>("associations", {}),
      languages: () =>
        vscode.extensions.all.flatMap((ext) => {
          const contributed = ext.packageJSON?.contributes?.languages as LanguageContribution[] | undefined;
          return contributed ?? [];
        }),
      locate: (id) => {
        for (const ext of vscode.extensions.all) {
          const themes = ext.packageJSON?.contributes?.iconThemes as Array<{ id: string; path: string }> | undefined;
          const theme = themes?.find((t) => t.id === id);
          if (!theme || ext.extensionUri.scheme !== "file") continue;
          const jsonPath = path.join(ext.extensionUri.fsPath, theme.path.replace(/^\.\//, ""));
          return { jsonPath, baseDir: path.dirname(jsonPath) };
        }
        return undefined;
      },
      readFile: (file) => vscode.workspace.fs.readFile(vscode.Uri.file(file)),
    });
    const refreshFileIcons = () => {
      this.fileIcons.invalidate();
      this.post({ type: "fileIcons", icons: {}, fonts: {}, reset: true });
    };
    this.disposables.push(
      this.context,
      vscode.window.onDidChangeActiveColorTheme(refreshFileIcons),
      vscode.extensions.onDidChange(refreshFileIcons),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.postInit();
        if (this.folder && !vscode.workspace.workspaceFolders?.some((f) => f.uri.toString() === this.folder?.uri.toString())) {
          void this.switchFolder(this.pickFolder());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("opencode.autoApprovePermissions")) {
          this.postAutoApprove();
          if (this.permissions.enabled(this.sessionId)) void this.approvePending();
        }
        if (e.affectsConfiguration("opencode.dropzone")) {
          this.post({ type: "dropzone", enabled: this.dropzoneEnabled() });
        }
        if (e.affectsConfiguration("workbench.iconTheme") || e.affectsConfiguration("files.associations")) {
          refreshFileIcons();
        }
      }),
    );
  }

  // ---- view wiring ------------------------------------------------------------------------

  attachView(view: vscode.WebviewView): void {
    this.view = view;
    const sub = view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.receive(msg));
    // Register the subscription both here and on view disposal: if the controller is disposed
    // while the view lives on, the old listener would otherwise keep it reachable forever.
    this.disposables.push(sub);
    this.disposables.push(view.onDidDispose(() => {
      sub.dispose();
      if (this.view === view) this.view = undefined;
    }));
    // The live stream has no replay: top up incrementally when the panel is shown again so a
    // chat left open in the background cannot drift from the server while it was hidden.
    this.disposables.push(view.onDidChangeVisibility(() => {
      // `resync()` also publishes a "connected" status, so never run it while still connecting.
      if (this.view === view && view.visible && this.status === "connected" && this.client) void this.resync();
    }));
  }

  /** Serializes webview messages: a late `ready`/loadAll must not race a prompt and drop its events. */
  private messageQueue: Promise<unknown> = Promise.resolve();

  /** Entry point for webview messages (also used by integration tests). */
  async receive(msg: WebviewMessage): Promise<void> {
    const run = this.messageQueue.then(() => this.handle(msg));
    // Keep the chain alive after a failed message so later ones are still processed.
    this.messageQueue = run.catch(() => undefined);
    try {
      await run;
    } catch (err) {
      this.output.error(`[chat] ${msg.type} failed: ${String(err)}`);
      const error = toUiError(err);
      // No `*.replied` event arrives for a failed reply, so tag the notice with the card it
      // belongs to; the webview uses it to re-enable the card's buttons for a retry.
      if (msg.type === "permissionReply") error.target = { kind: "permission", id: msg.requestId };
      else if (msg.type === "formReply" || msg.type === "formCancel") error.target = { kind: "form", id: msg.formId };
      this.post({ type: "notice", error });
    }
  }

  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  private readonly postListeners = new Set<(msg: HostMessage) => void>();

  post(msg: HostMessage): void {
    void this.view?.webview.postMessage(msg);
    for (const l of this.postListeners) l(msg);
  }

  /** Observes messages sent to the webview (used by integration tests). */
  onDidPost(listener: (msg: HostMessage) => void): vscode.Disposable {
    this.postListeners.add(listener);
    return new vscode.Disposable(() => this.postListeners.delete(listener));
  }

  /**
   * Marks a session idle in the webview without waiting for a server terminal event. OpenCode can
   * end a turn (a second interrupt, a dismissed question) without emitting one, which would leave
   * the composer stuck on "stop" forever.
   */
  private postLocalIdle(sid: string, generation = this.executionGen.current()): void {
    // Ignore late results: a newer prompt may have started while interrupt/cancel was in flight.
    if (sid !== this.sessionId || !this.executionGen.is(generation)) return;
    this.localIdle = { sid, generation };
    this.post({
      type: "event",
      event: { type: "session.status", data: { sessionID: sid, status: { type: "idle" } } } as ServerEvent,
    });
    // The server may emit no terminal event for a local idle, and `onEvent` is the only other
    // place that refreshes the list — so schedule it here or session rows stay "running" forever.
    this.scheduleSessions();
  }

  private pickFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active && vscode.workspace.getWorkspaceFolder(active)) ?? folders[0];
  }

  private postInit(): void {
    const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
    this.post({
      type: "init",
      strings: translatedStrings(),
      platform,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({ uri: f.uri.toString(), name: f.name })),
      activeFolder: this.folder?.uri.toString(),
      issuesUrl: (this.ctx.extension.packageJSON as { bugs?: { url?: string } }).bugs?.url,
      dropzone: this.dropzoneEnabled(),
    });
  }

  private dropzoneEnabled(): boolean {
    return vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<boolean>("dropzone", true);
  }

  private postConnection(status: ConnectionStatus = this.status, error = this.lastError): void {
    this.post({
      type: "connection",
      status,
      error,
      version: this.version,
      compatibility: checkCompatibility(this.version),
      compatibilityDismissed: !!this.version && this.ctx.globalState.get<string>(COMPAT_DISMISSED_KEY) === this.version,
      contract: this.contract,
      contractDismissed: this.ctx.globalState.get<string>(CONTRACT_DISMISSED_KEY) === contractSignature(this.contract),
    });
  }

  /** Recompute the contract report from all observations collected so far. */
  private observeContract(observations: Partial<ContractObservations>): void {
    this.contractObservations = { ...this.contractObservations, ...observations };
    this.contract = checkContract(this.contractObservations);
  }

  private setStatus(status: ConnectionStatus, error?: UiError): void {
    this.status = status;
    this.lastError = error;
    this.postConnection(status, error);
  }

  // ---- connection -------------------------------------------------------------------------

  /** Starts (or reuses) the server for the current folder and loads everything. */
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
    const generation = this.connectGen.current();
    const stale = () => !this.connectGen.is(generation);
    this.folder ??= this.pickFolder();
    if (!this.folder) {
      const s = translatedStrings();
      this.setStatus("error", { kind: "noWorkspace", message: s["error.noWorkspace"], actions: ["openFolder"] });
      return;
    }
    const server = this.registry.get(this.folder);
    if (server !== this.server) {
      this.serverSub?.();
      this.server = server;
      this.serverSub = server.onDidChange((s) => this.onServerState(s));
    }
    this.setStatus("starting");
    try {
      const conn = await server.ensure();
      // A folder switch / reset / reconnect may have happened while `ensure()` was starting the
      // server. Installing that connection would bind the chat to the wrong (or disposed) server.
      if (stale()) return;
      await this.useConnection(conn, server.state.status === "running" ? server.state.version : undefined, stale);
    } catch (err) {
      if (stale()) return;
      this.output.error(`[chat] connect failed: ${String(err)}`);
      this.setStatus("error", toUiError(err, "startFailed"));
    }
  }

  private async useConnection(
    conn: { baseUrl: string; password?: string },
    version?: string,
    isStale: () => boolean = () => false,
  ): Promise<void> {
    if (isStale()) return;
    if (this.client?.conn.baseUrl === conn.baseUrl && this.client.conn.password === conn.password && this.stream) {
      return;
    }
    this.stream?.close();
    this.client = new OpenCodeClient(conn);
    this.version = version;
    this.catalog.resetWarmUp();
    this.fileIndex?.dispose();
    this.fileIndex = this.folder ? new FileIndex(this.folder, this.ctx.workspaceState) : undefined;
    this.stream = new EventStream({
      url: this.client.eventUrl(),
      headers: this.client.headers(),
      onEvent: (e) => this.onEvent(e),
      onStatus: (status, error) => this.onStreamStatus(status, error),
    });
    this.stream.start();
    await this.loadAll();
    this.startLivePoll();
  }

  private async loadAll(): Promise<void> {
    const client = this.client;
    if (!client || !this.folder) return;
    const generation = this.loadGen.bump();
    const stale = () => !this.loadGen.is(generation);
    this.contractObservations = {};
    this.contract = emptyContract;
    const [models, defaultModel, agents] = await Promise.all([
      client.models().catch(() => [] as ModelInfo[]),
      client.defaultModel().catch(() => null),
      client.agents().catch((err: unknown) => {
        this.output.warn(`[chat] failed to load agents: ${String(err)}`);
        return [] as AgentInfo[];
      }),
    ]);
    // The contract report still observes the raw values: an adapter that silently drops malformed
    // entries must not hide a server version we cannot really support.
    if (stale()) return;
    this.catalog.setModelsAndAgents(models, defaultModel, agents);
    const sessionId = this.sessionId ?? this.ctx.workspaceState.get<string>(SESSION_KEY(this.folder.uri.toString()));
    let session: SessionInfo | undefined;
    if (sessionId) {
      session = await client.getSession(sessionId).catch(() => undefined);
      if (stale()) return;
    }
    // Plugin skills/commands are registered only once a session exists. With no session yet
    // (fresh window, or right after "New session") create a throwaway one so the `/` picker is
    // populated before the first prompt; the registrations survive deleting that session.
    if (!session && !this.catalog.isWarmedUp) {
      const tmp = await client.createSession({ directory: this.folder.uri.fsPath }).catch(() => undefined);
      if (tmp) {
        try {
          this.catalog.markWarmedUp();
          await this.catalog.refresh(client);
        } finally {
          await client.deleteSession(tmp.id).catch(() => {});
        }
      }
    }
    // Now that model/agent state is complete, a refreshed catalog (if any) can be posted safely.
    await this.catalog.refresh(client);
    if (stale()) return;
    this.observeContract({ version: this.version, models, agents, skills: this.catalog.skills });

    await this.refreshSessions();
    if (stale()) return;
    if (session) {
      await this.loadSession(session, stale);
    } else {
      if (stale()) return;
      this.sessionId = undefined;
      this.resetSubagents();
      this.catalog.publish();
      this.post({ type: "session", session: null });
      this.postAutoApprove();
    }
    if (this.catalog.models.length === 0) {
      const s = translatedStrings();
      this.setStatus("error", { kind: "noProvider", message: s["error.noProvider"], actions: ["login", "reconnect", "showLogs"] });
    } else {
      this.setStatus("connected");
    }
    this.post({ type: "context", items: this.context.current() });
  }

  /** OpenCode registers plugin catalog items only once a session exists; keep the picker fresh. */
  private async refreshSlashItems(): Promise<void> {
    if (this.client) await this.catalog.refresh(this.client);
  }

  private onServerState(state: ServerState): void {
    if (state.status === "starting" && this.status === "connected") {
      this.setStatus("reconnecting");
    } else if (
      state.status === "running" &&
      this.client &&
      (this.client.conn.baseUrl !== state.conn.baseUrl || this.client.conn.password !== state.conn.password)
    ) {
      // The managed process was restarted: the port *and* the random password can change.
      // Comparing only the URL would leave a stale client on a reused port (endless 401s).
      void this.useConnection(state.conn, state.version).then(
        () => this.output.info("[chat] reconnected to restarted server"),
        (err: unknown) => this.setStatus("error", toUiError(err)),
      );
    } else if (state.status === "failed") {
      this.stream?.close();
      this.stream = undefined;
      this.setStatus("error", toUiError(state.error, "startFailed"));
    }
  }

  private onStreamStatus(status: string, error?: unknown): void {
    if (status === "reconnecting") {
      this.output.warn(`[events] disconnected: ${String(error ?? "stream ended")}`);
      if (this.status === "connected") this.setStatus("reconnecting");
      this.wasDisconnected = true;
      if (this.server instanceof ExternalServer) {
        void this.client?.info().catch((err: unknown) => {
          if (this.status !== "error") {
            const s = translatedStrings();
            this.setStatus("reconnecting", {
              kind: "connectionLost",
              message: s["error.connectionLost"],
              detail: String(err),
              actions: ["reconnect", "showLogs"],
            });
          }
        });
      }
    } else if (status === "connected" && this.wasDisconnected) {
      this.wasDisconnected = false;
      this.output.info("[events] reconnected, resyncing");
      void this.resync();
    }
  }

  /**
   * Applies only the messages added since the last load. The SSE stream is live-only and has no
   * replay, but the history endpoint can find the overlap by id (`order=desc`). When nothing (or
   * only a few messages) changed, the webview keeps its scroll position, attachments and draft
   * instead of being rebuilt from a full `session` payload.
   *
   * Returns `false` when the overlap is unknown (history trimmed/compacted) so the caller falls
   * back to a full load. This is best-effort: a failed tail fetch must never lose a conversation.
   */
  private async resyncTail(
    sid: string,
    rawInfo: SessionInfo,
    stale: () => boolean,
    busyOverride?: boolean,
    prefetched?: SessionMessage[],
  ): Promise<boolean> {
    const client = this.client;
    if (!client || this.lastKnownMessage?.sessionId !== sid) return false;
    const rawNewer = prefetched ?? (await client.messagesNewerThan(sid, this.lastKnownMessage.id).catch(() => undefined));
    if (rawNewer === undefined || stale()) return false;
    const [rawPermissions, rawForms] = await Promise.all([
      client.permissions(sid).catch(() => [] as PermissionRequest[]),
      client.forms(sid).catch(() => [] as FormRequest[]),
    ]);
    if (stale()) return true;
    const info = normalizeSessionInfo(rawInfo) ?? rawInfo;
    const newer = normalizeList(rawNewer, normalizeSessionMessage);
    const pending = await this.permissions.filterPending(client, sid, normalizeList(rawPermissions, normalizePermission));
    if (stale()) return true;
    const last = newer.at(-1);
    if (last) this.lastKnownMessage = { sessionId: sid, id: last.id };
    this.postAutoApprove();
    this.post({
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
    void this.refreshChanges().catch(() => {});
    return true;
  }

  /** Live stream has no replay: re-fetch the current session after a reconnect. */
  private async resync(): Promise<void> {
    try {
      const generation = this.loadGen.current();
      const sid = this.sessionId;
      await this.refreshSessions();
      if (sid && sid === this.sessionId && this.client) {
        const info = await this.client.getSession(sid);
        if (!this.loadGen.is(generation) || sid !== this.sessionId) return;
        const busyOverride = this.localIdle?.sid === sid && this.localIdle.generation === generation ? false : undefined;
        const stale = () => !this.loadGen.is(generation) || sid !== this.sessionId;
        if (!(await this.resyncTail(sid, info, stale, busyOverride))) {
          await this.loadSession(info, stale, busyOverride);
        }
      }
      if (this.status !== "error" || this.lastError?.kind === "connectionLost") this.setStatus("connected");
    } catch (err) {
      this.output.error(`[chat] resync failed: ${String(err)}`);
    }
  }

  /**
   * Manual sync from the header button: an authoritative reload from the server, meant to repair a
   * chat whose live state drifted. Unlike the visibility top-up, this rebuilds the webview state.
   * The completion notice is sent in `finally` so the button can never stay stuck on "syncing".
   */
  private async syncNow(): Promise<void> {
    try {
      const client = this.client;
      const sid = this.sessionId;
      if (!client || !sid) return;
      const generation = this.loadGen.bump();
      const info = await client.getSession(sid);
      if (!this.loadGen.is(generation) || sid !== this.sessionId) return;
      await this.loadSession(info, () => !this.loadGen.is(generation) || sid !== this.sessionId);
    } finally {
      this.post({ type: "synced" });
    }
  }

  /**
   * The SSE stream is scoped to the server process we connected to. Another client (e.g. the TUI
   * running as a separate process) writes sessions to the same on-disk storage but emits no event
   * on our stream, so its prompts are invisible until a manual Sync/Reconnect re-reads history.
   * Poll the open session's tail instead and fold new messages in through the same `sessionDelta`
   * path used on reconnect, so an external conversation shows up live while the chat is visible.
   */
  private startLivePoll(): void {
    if (this.livePollTimer) return;
    this.livePollTimer = setInterval(() => void this.pollSessionTail(), LIVE_POLL_MS);
  }

  private stopLivePoll(): void {
    if (this.livePollTimer) clearInterval(this.livePollTimer);
    this.livePollTimer = undefined;
  }

  private async pollSessionTail(force = false): Promise<void> {
    const client = this.client;
    const sid = this.sessionId;
    if (!client || !sid || this.status !== "connected" || (!force && !this.isVisible)) return;
    // Local turns are driven by live events; polling them would only re-post partial snapshots and
    // could pull a streaming card back to an older history state. Wait for the stream to go quiet.
    if (!force && Date.now() - this.lastSessionEventAt < LIVE_POLL_MS) return;
    const head = this.lastKnownMessage;
    if (!head || head.sessionId !== sid) return;
    try {
      const generation = this.loadGen.current();
      const stale = () => !this.loadGen.is(generation) || sid !== this.sessionId;
      // The tail itself is authoritative. `time.updated` is not a reliable gate: it can stay equal
      // on a coarse clock, or move for changes we do not render, which used to hide real messages.
      const newer = await client.messagesNewerThan(sid, head.id).catch(() => undefined);
      if (!newer || newer.length === 0 || stale()) return;
      const info = await client.getSession(sid);
      if (stale()) return;
      const busyOverride = this.localIdle?.sid === sid && this.localIdle.generation === generation ? false : undefined;
      // A trimmed/compacted history has no overlap with our high-water mark: fall back to a full
      // load, the same way a reconnect does. It resets the mark, so this cannot repeat every tick.
      if (!(await this.resyncTail(sid, info, stale, busyOverride, newer))) {
        await this.loadSession(info, stale, busyOverride);
      }
      void this.refreshSessions().catch(() => {});
    } catch (err) {
      // A transient failure must not kill the poll: the next tick tries again.
      this.output.warn(`[chat] live poll failed: ${String(err)}`);
    }
  }

  /** Exposed for integration tests: run one poll now, independent of visibility and event quiet. */
  pollNow(): Promise<void> {
    return this.pollSessionTail(true);
  }

  // ---- subagents --------------------------------------------------------------------------

  /** Whether an id is the current session or one of its (possibly nested) child sessions. */
  private isTrackedSession(id: string): boolean {
    if (id === this.sessionId) return true;
    let parent = this.sessionParents.get(id);
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === this.sessionId) return true;
      seen.add(parent);
      parent = this.sessionParents.get(parent);
    }
    return false;
  }

  private resetSubagents(): void {
    this.childGen.bump();
    this.childSessions.clear();
    this.sessionParents.clear();
    this.pendingChildEvents.clear();
  }

  /**
   * `subagent` calls publish the child id in their progress/success metadata, and OpenCode also
   * emits `session.created` with `parentID`. Either signal is enough to start following a child:
   * its events then arrive on the same global stream with a different `sessionID`.
   */
  private trackSubagent(childId: string, created?: { parentId?: string; title?: string; agent?: string }): void {
    if (!this.sessionId || childId === this.sessionId || this.childSessions.has(childId)) return;
    if (this.childSessions.size >= ChatController.MAX_CHILD_SESSIONS) {
      const oldest = this.childSessions.values().next().value;
      if (oldest) {
        this.childSessions.delete(oldest);
        this.pendingChildEvents.delete(oldest);
        this.sessionParents.delete(oldest);
      }
    }
    this.childSessions.add(childId);
    this.pendingChildEvents.set(childId, []);
    if (created?.parentId) this.sessionParents.set(childId, created.parentId);
    void this.loadSubagentSnapshot(childId, created);
  }

  /** One history fetch on discovery makes the child view complete even after a reconnect. */
  private async loadSubagentSnapshot(
    childId: string,
    created?: { parentId?: string; title?: string; agent?: string },
  ): Promise<void> {
    const client = this.client;
    const parent = this.sessionId;
    if (!client || !parent) return;
    const generation = this.childGen.current();
    const [info, rawMessages, rawPermissions, rawForms] = await Promise.all([
      client.getSession(childId).catch(() => undefined),
      client.messages(childId).catch(() => []),
      client.permissions(childId).catch(() => []),
      client.forms(childId).catch(() => []),
    ]);
    if (!this.childGen.is(generation) || parent !== this.sessionId) return;
    const safe = normalizeSessionInfo(info) ?? info;
    const messages = normalizeList(rawMessages, normalizeSessionMessage);
    this.post({
      type: "subagent",
      snapshot: {
        sessionId: childId,
        parentId: safe?.parentID ?? created?.parentId ?? this.sessionParents.get(childId),
        title: created?.title ?? safe?.title,
        agent: created?.agent ?? safe?.agent,
        messages,
        permissions: normalizeList(rawPermissions, normalizePermission),
        forms: normalizeList(rawForms, normalizeForm),
        busy: safe ? sessionIsBusy(safe.time, messages) : true,
      },
    });
    // The snapshot replaces the child's webview state; replay everything received while it loaded.
    const buffered = this.pendingChildEvents.get(childId) ?? [];
    this.pendingChildEvents.delete(childId);
    for (const event of buffered) this.post({ type: "subagentEvent", sessionId: childId, event });
  }

  // ---- events -----------------------------------------------------------------------------

  private onEvent(event: ServerEvent): void {
    const normalized = normalizeServerEvent(event);
    if (!normalized) return;
    event = normalized;
    const sid = eventSessionId(event);
    if (sid && sid === this.sessionId) this.lastSessionEventAt = Date.now();
    if (event.type === "session.created") {
      const data = event.data as { sessionID?: string; parentID?: string; title?: string; agent?: string };
      if (data.sessionID && data.parentID) {
        this.sessionParents.set(data.sessionID, data.parentID);
        if (this.isTrackedSession(data.sessionID)) {
          this.trackSubagent(data.sessionID, data);
        }
      }
    }
    if (sid === this.sessionId && event.type === "session.tool.progress") {
      const childId = (event.data as { metadata?: { sessionID?: unknown } }).metadata?.sessionID;
      if (typeof childId === "string" && childId) this.trackSubagent(childId);
    }
    if (sid === this.sessionId && event.type === "session.inbox.enqueued") {
      // A background child announces its final report after the parent turn has already ended.
      // Re-read its history now: that is when the steps and the report are actually complete.
      const item = (event.data as { item?: { type?: string; payload?: { text?: string } } }).item;
      const parsed = item?.type === "synthetic" ? parseSubagentReport(item.payload?.text) : undefined;
      if (parsed && this.sessionId) {
        this.sessionParents.set(parsed.sessionId, this.sessionId);
        if (this.childSessions.has(parsed.sessionId)) void this.loadSubagentSnapshot(parsed.sessionId);
        else this.trackSubagent(parsed.sessionId);
      }
    }
    if (event.type === "session.deleted" && sid && this.childSessions.delete(sid)) {
      this.sessionParents.delete(sid);
      this.pendingChildEvents.delete(sid);
    }
    if (event.type === "permission.replied") {
      const requestId = (event.data as { requestID?: string }).requestID;
      if (requestId) this.permissions.forgetRequest(requestId);
    }
    // Plugin skills/commands can be registered or removed while the chat is open.
    if (event.type === "skill.updated" || event.type === "command.updated") void this.refreshSlashItems();
    // Bypass the inline card: grant each request on arrival instead of asking the user.
    if (event.type === "permission.asked" && sid && sid === this.sessionId && this.permissions.enabled(sid)) {
      void this.autoApprove(event, sid);
      return;
    }
    if (sid && sid === this.sessionId) this.post({ type: "event", event });
    else if (sid && this.childSessions.has(sid)) {
      const buffered = this.pendingChildEvents.get(sid);
      if (buffered) {
        if (buffered.length < 500) buffered.push(event);
      } else {
        this.post({ type: "subagentEvent", sessionId: sid, event });
      }
    }
    // Any new turn invalidates a pending history reconcile from the previous one, and ends the
    // grace period in which a resync must not re-lock a locally cleared composer.
    if (sid === this.sessionId && (event.type === "session.inbox.enqueued" || event.type === "session.execution.started")) {
      this.executionGen.bump();
      this.localIdle = undefined;
    }
    switch (event.type) {
      case "session.created":
      case "session.renamed":
      case "session.deleted":
      case "session.execution.started":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.status":
      case "permission.asked":
      case "permission.replied":
      case "form.created":
      case "form.replied":
      case "form.cancelled":
        // Busy/idle and pending-input transitions both change the session list indicator.
        this.scheduleSessions();
        break;
      default:
        break;
    }
    if (
      sid === this.sessionId &&
      (event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted")
    ) {
      this.scheduleReconcile();
    }
    if (event.type === "session.deleted" && sid === this.sessionId) {
      void this.newSession();
    }
    if (sid === this.sessionId && event.type === "session.step.ended") {
      const files = (event.data as { files?: string[] }).files;
      if (files && files.length > 0) this.scheduleChanges();
    }
    if (sid === this.sessionId && (event.type === "permission.asked" || event.type === "form.created") && !this.isVisible) {
      const msg =
        event.type === "permission.asked"
          ? vscode.l10n.t("OpenCode is asking for permission.")
          : vscode.l10n.t("OpenCode is asking a question.");
      const open = vscode.l10n.t("Open chat");
      void vscode.window.showInformationMessage(msg, open).then((choice) => {
        if (choice === open) void vscode.commands.executeCommand("opencode.chatView.focus");
      });
    }
  }

  /** Cancel all deferred work from the previous connection/session before switching or resetting. */
  private clearTimers(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = undefined;
    if (this.changesTimer) clearTimeout(this.changesTimer);
    this.changesTimer = undefined;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }

  private postAutoApprove(): void {
    this.post({ type: "autoApprove", enabled: this.permissions.enabled(this.sessionId) });
  }

  /** Drafts live in workspaceState so they survive a window reload (vscode.setState does not). */
  private postDrafts(): void {
    if (!this.folder) return;
    const saved = this.ctx.workspaceState.get<{ drafts?: Record<string, string>; globalDraft?: string }>(DRAFTS_KEY(this.folder.uri.toString()));
    this.post({ type: "drafts", drafts: saved?.drafts ?? {}, globalDraft: saved?.globalDraft });
  }

  private async saveDraft(sessionId: string | undefined, text: string): Promise<void> {
    if (!this.folder) return;
    const key = DRAFTS_KEY(this.folder.uri.toString());
    const saved = this.ctx.workspaceState.get<{ drafts?: Record<string, string>; globalDraft?: string }>(key) ?? {};
    if (sessionId === undefined) {
      await this.ctx.workspaceState.update(key, { ...saved, globalDraft: text });
    } else {
      await this.ctx.workspaceState.update(key, { ...saved, drafts: { ...saved.drafts, [sessionId]: text } });
    }
  }

  private async setAutoApprove(enabled: boolean): Promise<void> {
    if (this.sessionId) await this.permissions.write(this.sessionId, enabled);
    else this.permissions.setPending(enabled);
    this.postAutoApprove();
    if (enabled) await this.approvePending();
  }

  private async autoApprove(event: ServerEvent, sessionId: string): Promise<void> {
    const request = event.data as PermissionRequest;
    const client = this.client;
    if (!client || !(await this.permissions.approveOnce(client, sessionId, request.id))) {
      if (sessionId === this.sessionId) this.post({ type: "event", event });
      return;
    }
    this.output.info(`[chat] auto-approved ${request.action} (${sessionId})`);
  }

  /** Grants requests that were already pending when auto-approval was turned on. */
  private async approvePending(): Promise<void> {
    const client = this.client;
    const sid = this.sessionId;
    if (!client || !sid || !this.permissions.enabled(sid)) return;
    const pending = await client.permissions(sid).catch(() => [] as PermissionRequest[]);
    for (const request of pending) {
      if (!(await this.permissions.approveOnce(client, sid, request.id))) {
        // The grant failed: make sure a card is shown instead of silently leaving the agent blocked.
        this.post({ type: "event", event: { type: "permission.asked", data: request } });
      }
    }
  }

  private scheduleSessions(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => void this.refreshSessions().catch(() => {}), 250);
  }

  private scheduleChanges(): void {
    if (this.changesTimer) clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.refreshChanges().catch(() => {}), 400);
  }

  /**
   * The event stream is live-only, so a missed terminal event can leave the webview showing an
   * incomplete turn forever. After each turn, re-read the session and replace the webview state.
   * Skipped when another prompt starts meanwhile, since its live events are newer than the snapshot.
   */
  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    const sid = this.sessionId;
    const generation = this.executionGen.current();
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      if (!sid || sid !== this.sessionId || !this.executionGen.is(generation)) return;
      void this.reconcileSession(sid, generation);
    }, 350);
  }

  private async reconcileSession(sid: string, generation: number): Promise<void> {
    if (!this.client || sid !== this.sessionId) return;
    try {
      const info = await this.client.getSession(sid);
      if (sid !== this.sessionId || !this.executionGen.is(generation)) return;
      // If the composer was cleared locally and no new turn has started, the server's timestamps
      // are stale (a dismissed question can leave `busy` newer than `idle` with no idle message).
      // Keep it unlocked instead of re-syncing back to "stop".
      const busyOverride = this.localIdle?.sid === sid && this.localIdle.generation === generation ? false : undefined;
      const stale = () => sid !== this.sessionId || !this.executionGen.is(generation);
      if (!(await this.resyncTail(sid, info, stale, busyOverride))) {
        await this.loadSession(info, stale, busyOverride);
      }
    } catch (err) {
      // A failed reconcile is not worth surfacing: the live stream may still have delivered everything.
      this.output.warn(`[chat] session reconcile failed: ${String(err)}`);
    }
  }

  private postSessions(): void {
    this.post({ type: "sessions", items: this.sessionItems, currentId: this.sessionId, hasMore: this.sessionsHasMore });
  }

  /**
   * The cheap session list only carries timestamps. Only entries that look busy need their history
   * and pending requests fetched: a terminal `idle` message can prove the busy flag stale after an
   * interrupt, and the list should agree with the chat that already uses `sessionIsBusy`.
   */
  private async toSummaries(sessions: SessionInfo[]): Promise<SessionSummary[]> {
    const client = this.client;
    return Promise.all(
      sessions.map(async (info) => {
        const safe = normalizeSessionInfo(info) ?? info;
        if (!client || !sessionLooksBusy(safe.time)) return toSessionSummary(safe);
        // Only a session whose turn is still running can be paused on a question or a permission
        // request, so fetch the pending-input state together with the history we already need.
        const [messages, permissions, forms] = await Promise.all([
          client.messages(info.id).catch(() => undefined),
          client.permissions(info.id).catch(() => []),
          client.forms(info.id).catch(() => []),
        ]);
        return toSessionSummary(safe, messages && normalizeList(messages, normalizeSessionMessage), permissions.length > 0 || forms.length > 0);
      }),
    );
  }

  /** Page size for the session list; kept small so the picker stays scannable. */
  private sessionPageSize(): number {
    const configured = vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<number>("sessionPageSize", 10);
    return Math.min(100, Math.max(1, Math.floor(configured) || 10));
  }

  async refreshSessions(): Promise<void> {
    if (!this.client || !this.folder) return;
    const generation = this.sessionsGen.bump();
    const { items, next } = await this.client.listSessionsPage(this.folder.uri.fsPath, this.sessionPageSize());
    const sessions = items.filter((s) => !s.parentID && !s.time.archived);
    const summaries = await this.toSummaries(sessions);
    if (!this.sessionsGen.is(generation)) return;
    this.sessionItems = summaries;
    this.sessionsCursor = next;
    this.sessionsHasMore = !!next;
    this.postSessions();
  }

  /** Appends the next page of sessions without discarding the ones already loaded. */
  async loadMoreSessions(): Promise<void> {
    if (!this.client || !this.folder || !this.sessionsCursor || this.sessionsLoadingMore) return;
    this.sessionsLoadingMore = true;
    const generation = this.sessionsGen.current();
    try {
      const { items, next } = await this.client.listSessionsPage(this.folder.uri.fsPath, this.sessionPageSize(), this.sessionsCursor);
      const known = new Set(this.sessionItems.map((s) => s.id));
      const fresh: SessionInfo[] = [];
      for (const s of items) {
        if (s.parentID || s.time.archived || known.has(s.id)) continue;
        known.add(s.id);
        fresh.push(s);
      }
      const summaries = await this.toSummaries(fresh);
      if (!this.sessionsGen.is(generation)) return;
      this.sessionItems.push(...summaries);
      this.sessionsCursor = next;
      this.sessionsHasMore = !!next;
      this.postSessions();
    } catch (err) {
      this.output.warn(`[chat] failed to load more sessions: ${String(err)}`);
    } finally {
      this.sessionsLoadingMore = false;
    }
  }

  /**
   * Deletes every session in the workspace folder, including pages that were never loaded in the
   * picker. All ids are collected first because pagination uses offset cursors: deleting while
   * walking the pages would shift the offsets and skip sessions.
   */
  async deleteAllSessions(): Promise<void> {
    const client = this.client;
    const folder = this.folder;
    if (!client || !folder) return;
    const directory = folder.uri.fsPath;
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const { items, next } = await client.listSessionsPage(directory, 100, cursor);
      for (const info of items) ids.add(info.id);
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }

    const currentId = this.sessionId;
    const deleted: string[] = [];
    for (const id of ids) {
      try {
        await client.deleteSession(id);
        deleted.push(id);
        await this.permissions.write(id, undefined);
      } catch (err) {
        // A child already removed with its parent (or a stale session) must not abort the cleanup.
        this.output.warn(`[chat] failed to delete session ${id}: ${String(err)}`);
      }
    }

    if (deleted.length > 0) {
      const key = DRAFTS_KEY(folder.uri.toString());
      const saved = this.ctx.workspaceState.get<{ drafts?: Record<string, string> }>(key) ?? {};
      if (saved.drafts) {
        const drafts = { ...saved.drafts };
        for (const id of deleted) delete drafts[id];
        await this.ctx.workspaceState.update(key, { ...saved, drafts });
      }
    }

    if (ids.size > 0 && deleted.length === 0) {
      // Nothing could be removed; keep the chat as it is and let the list re-sync from the server.
      await this.refreshSessions();
      throw new Error(translatedStrings()["error.requestFailed"]);
    }
    // Clear the current chat when its session was among the deleted ones (also covers "no session").
    if (!currentId || ids.has(currentId)) await this.newSession();
    else await this.refreshSessions();
  }

  async refreshChanges(): Promise<FileDiff[]> {
    let files: FileDiff[] = [];
    if (this.client && this.sessionId) {
      files = normalizeList(await this.client.diff(this.sessionId).catch(() => [] as FileDiff[]), normalizeFileDiff);
    }
    this.post({ type: "changedFiles", files });
    return files;
  }

  /** Ask the server to compact the current session (runs at the next step boundary). */
  async compact(): Promise<void> {
    const sid = this.sessionId;
    if (!sid || !this.client) return;
    try {
      await this.client.compact(sid);
      this.output.info("[chat] compaction requested");
    } catch (err) {
      const s = translatedStrings();
      this.post({
        type: "notice",
        error: {
          kind: "requestFailed",
          message: s["error.compactFailed"],
          detail: err instanceof Error ? err.message : String(err),
          actions: ["showLogs"],
        },
      });
    }
  }

  private async loadSession(rawInfo: SessionInfo, stale?: () => boolean, busyOverride?: boolean): Promise<void> {
    const client = this.client;
    if (!client || !this.folder) return;
    const [rawMessages, rawPermissions, rawForms] = await Promise.all([
      client.messages(rawInfo.id),
      client.permissions(rawInfo.id).catch(() => []),
      client.forms(rawInfo.id).catch(() => []),
    ]);
    // A newer prompt may have started while history was loading; its events are fresher.
    if (stale?.()) return;
    this.observeContract({ messages: rawMessages });
    const info = normalizeSessionInfo(rawInfo) ?? rawInfo;
    const messages = normalizeList(rawMessages, normalizeSessionMessage);
    const forms = normalizeList(rawForms, normalizeForm);
    if (this.sessionId !== info.id) this.resetSubagents();
    // Past subagents have no live stream on a reload; load their history for the inline cards.
    for (const id of subagentSessionsFromMessages(messages)) this.trackSubagent(id);
    this.sessionId = info.id;
    const newest = messages.at(-1);
    this.lastKnownMessage = newest ? { sessionId: info.id, id: newest.id } : undefined;
    // Requests granted automatically must not linger as cards when the chat's toggle is on.
    const pending = await this.permissions.filterPending(client, info.id, normalizeList(rawPermissions, normalizePermission));
    await this.ctx.workspaceState.update(SESSION_KEY(this.folder.uri.toString()), info.id);
    if (info.model && this.catalog.models.some((m) => m.id === info.model?.id && m.providerID === info.model?.providerID)) {
      this.catalog.selectedModel = info.model;
    }
    if (info.agent && this.catalog.agents.some((a) => a.id === info.agent)) this.catalog.selectedAgent = info.agent;
    await this.refreshSlashItems();
    if (stale?.()) return;
    this.catalog.publish();
    this.post({
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
    this.postAutoApprove();
    await this.refreshSessions();
    const diff = await this.refreshChanges();
    this.observeContract({ diff });
  }

  // ---- commands ---------------------------------------------------------------------------

  async newSession(): Promise<void> {
    this.loadGen.bump();
    this.clearTimers();
    this.sessionId = undefined;
    this.resetSubagents();
    this.lastKnownMessage = undefined;
    this.permissions.setPending(undefined);
    if (this.folder) await this.ctx.workspaceState.update(SESSION_KEY(this.folder.uri.toString()), undefined);
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.postAutoApprove();
    this.catalog.publish();
    await this.refreshSessions().catch(() => {});
    this.post({ type: "focusInput" });
  }

  async reconnect(): Promise<void> {
    const generation = this.connectGen.bump();
    const stale = () => !this.connectGen.is(generation);
    this.connecting = undefined;
    this.loadGen.bump();
    this.clearTimers();
    if (!this.server) return this.connect();
    this.setStatus("starting");
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
    this.lastKnownMessage = undefined;
    this.stopLivePoll();
    try {
      const conn = await this.server.restart();
      if (stale()) return;
      await this.useConnection(conn, this.server.state.status === "running" ? this.server.state.version : undefined, stale);
    } catch (err) {
      if (stale()) return;
      this.setStatus("error", toUiError(err, "startFailed"));
    }
  }

  async resetServers(): Promise<void> {
    this.connectGen.bump();
    this.connecting = undefined;
    this.loadGen.bump();
    this.clearTimers();
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
    this.lastKnownMessage = undefined;
    this.stopLivePoll();
    this.serverSub?.();
    this.serverSub = undefined;
    this.server = undefined;
    await this.registry.reset();
    if (this.view) await this.connect();
  }

  async switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (folder?.uri.toString() === this.folder?.uri.toString()) return;
    this.connectGen.bump();
    this.connecting = undefined;
    this.loadGen.bump();
    this.clearTimers();
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
    this.sessionId = undefined;
    this.lastKnownMessage = undefined;
    this.stopLivePoll();
    this.permissions.setPending(undefined);
    this.sessionsGen.bump();
    this.sessionItems = [];
    this.sessionsCursor = undefined;
    this.sessionsHasMore = false;
    this.folder = folder;
    this.postInit();
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.postSessions();
    this.postAutoApprove();
    await this.connect();
  }

  addAttachment(item: Attachment): void {
    this.post({ type: "addAttachment", item });
  }

  /**
   * Inline attachment: OpenCode puts a `data:` URL's decoded content straight into the prompt. A
   * `file:` URL outside the project only gives the agent a path, so it wastes turns looking for it.
   */
  private attachInline(name: string, base64: string, mime: string | undefined, detail?: string): void {
    if (Buffer.byteLength(base64, "base64") > MAX_ATTACHMENT_BYTES) {
      this.noticeTooLarge(name);
      return;
    }
    this.addAttachment({ uri: `data:${mime || mimeFromName(name)};base64,${base64}`, name, kind: "file", detail });
  }

  private noticeTooLarge(name: string): void {
    const s = translatedStrings();
    this.post({ type: "notice", error: { kind: "requestFailed", message: s["error.attachmentTooLarge"], detail: name, actions: [] } });
  }

  private noticeUnreadable(name: string, detail: string): void {
    const s = translatedStrings();
    this.post({ type: "notice", error: { kind: "requestFailed", message: s["error.attachmentUnreadable"], detail, actions: ["showLogs"] } });
    this.output.warn(`[chat] skipped unreadable attachment ${name}: ${detail}`);
  }

  /**
   * Adds a file to the chat. Goes through {@link attachUri} so files outside the workspace are
   * inlined instead of sending OpenCode a path it may not be able to read.
   */
  async addFile(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== "file") return;
    try {
      await this.attachUri(uri);
    } catch (err) {
      this.noticeUnreadable(path.basename(uri.fsPath), err instanceof Error ? err.message : String(err));
    }
  }

  private async attachUri(uri: vscode.Uri, name?: string): Promise<void> {
    if (uri.scheme !== "file") return;
    const label = name || path.basename(uri.fsPath);
    const detail = vscode.workspace.asRelativePath(uri, false);
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      // The server can read project files itself, preserving line ranges on @-mentions.
      this.addAttachment({ uri: uri.toString(), name: label, kind: "file", detail });
      return;
    }
    // Outside the workspace: send the content inline so the model actually receives it.
    const stat = await fs.stat(uri.fsPath);
    if (stat.size > MAX_ATTACHMENT_BYTES) return this.noticeTooLarge(label);
    const bytes = await fs.readFile(uri.fsPath);
    this.attachInline(label, bytes.toString("base64"), mimeFromName(label), detail);
  }

  /** Files dropped into the webview, which cannot expose a path for OS drags. */
  private async dropFiles(files: DroppedFile[]): Promise<void> {
    for (const file of files) {
      try {
        if (file.base64) {
          this.attachInline(file.name, file.base64, file.mime, file.name);
          continue;
        }
        const uri = file.uri
          ? (() => {
              const parsed = vscode.Uri.parse(file.uri);
              return parsed.scheme === "file" ? parsed : undefined;
            })()
          : file.path
            ? vscode.Uri.file(file.path)
            : undefined;
        if (uri) await this.attachUri(uri, file.name);
      } catch (err) {
        this.output.warn(`[chat] failed to attach dropped file ${file.name}: ${String(err)}`);
      }
    }
  }

  /** Native file picker: a reliable alternative to drag & drop, which VS Code gates behind Shift. */
  async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      title: vscode.l10n.t("Attach files to the chat"),
      openLabel: vscode.l10n.t("Attach"),
    });
    if (!uris) return;
    for (const uri of uris) {
      try {
        await this.attachUri(uri);
      } catch (err) {
        this.output.warn(`[chat] failed to attach picked file ${uri.fsPath}: ${String(err)}`);
      }
    }
  }

  addSelection(editor: vscode.TextEditor | undefined): boolean {
    if (!editor) return false;
    const att = selectionAttachment(editor);
    if (!att) return false;
    this.addAttachment(att);
    return true;
  }

  async setPassword(): Promise<void> {
    // Use the same folder scope as ServerRegistry.get(), otherwise a per-folder endpoint in a
    // multi-root workspace is invisible here (and the secret would be stored under the wrong key).
    const endpoint = vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<string>("endpoint", "").trim();
    if (!endpoint) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("A password is only needed for an external server (setting opencode.endpoint). The managed server uses a random password automatically."),
      );
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Password for the OpenCode server at {0}", endpoint),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value) await this.ctx.secrets.store(PASSWORD_KEY(endpoint), value);
    else await this.ctx.secrets.delete(PASSWORD_KEY(endpoint));
    await this.resetServers();
  }

  async runAction(id: ActionId): Promise<void> {
    switch (id) {
      case "reconnect":
        return this.reconnect();
      case "showLogs":
        this.output.show(true);
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:mattiamalonni.chat-for-opencode");
        return;
      case "install":
        await vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai/docs/"));
        return;
      case "login": {
        const exe = vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<string>("executablePath", "opencode").trim() || "opencode";
        let command: string;
        try {
          command = `${quoteForShell(exe)} auth login`;
        } catch (err) {
          void vscode.window.showErrorMessage(vscode.l10n.t("Cannot run OpenCode sign-in: {0}", err instanceof Error ? err.message : String(err)));
          return;
        }
        const terminal = vscode.window.createTerminal({ name: "OpenCode auth", cwd: this.folder?.uri });
        terminal.show();
        terminal.sendText(command);
        return;
      }
      case "setPassword":
        return this.setPassword();
      case "openFolder":
        await vscode.commands.executeCommand("vscode.openFolder");
        return;
      case "newSession":
        return this.newSession();
    }
  }

  // ---- webview messages -------------------------------------------------------------------

  private async handle(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postInit();
        this.postConnection();
        this.postDrafts();
        if (this.client && this.status !== "error") {
          await this.loadAll();
        } else {
          await this.connect();
        }
        return;
      case "send":
        return this.send(msg.text, msg.attachments, msg.context, msg.delivery);
      case "abort": {
        const sid = this.sessionId;
        const generation = this.executionGen.current();
        if (this.client && sid) {
          await this.client.interrupt(sid);
          // A server that receives a second interrupt on an already-idle session emits no
          // terminal event. Clear busy locally so the composer can never stay stuck on "stop".
          this.postLocalIdle(sid, generation);
        }
        return;
      }
      case "newSession":
        return this.newSession();
      case "selectSession": {
        if (!this.client) return;
        const generation = this.loadGen.bump();
        const info = await this.client.getSession(msg.id);
        if (!this.loadGen.is(generation)) return;
        return this.loadSession(info, () => !this.loadGen.is(generation));
      }
      case "deleteSession":
        if (!this.client) return;
        await this.client.deleteSession(msg.id);
        await this.permissions.write(msg.id, undefined);
        if (this.folder) {
          const key = DRAFTS_KEY(this.folder.uri.toString());
          const saved = this.ctx.workspaceState.get<{ drafts?: Record<string, string> }>(key) ?? {};
          if (saved.drafts?.[msg.id] !== undefined) {
            const drafts = { ...saved.drafts };
            delete drafts[msg.id];
            await this.ctx.workspaceState.update(key, { ...saved, drafts });
          }
        }
        if (msg.id === this.sessionId) await this.newSession();
        else await this.refreshSessions();
        return;
      case "deleteAllSessions": {
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Delete all sessions?"),
          {
            modal: true,
            detail: vscode.l10n.t("Every session in this workspace will be permanently removed. This cannot be undone."),
          },
          vscode.l10n.t("Delete all"),
        );
        if (answer === undefined) return;
        return this.deleteAllSessions();
      }
      case "renameSession": {
        if (!this.client) return;
        const title = msg.title.trim();
        if (!title) return;
        await this.client.renameSession(msg.id, title);
        // Update optimistically so the header/list react even if the live event is missed.
        const item = this.sessionItems.find((s) => s.id === msg.id);
        if (item) {
          item.title = title;
          this.postSessions();
        }
        if (msg.id === this.sessionId) {
          this.post({ type: "event", event: { type: "session.renamed", data: { sessionID: msg.id, title } } });
        }
        return;
      }
      case "refreshSessions":
        return this.refreshSessions();
      case "loadMoreSessions":
        return this.loadMoreSessions();
      case "setModel":
        this.catalog.selectModel(msg.model);
        if (this.client && this.sessionId) await this.client.switchModel(this.sessionId, msg.model);
        return;
      case "setAgent":
        this.catalog.selectAgent(msg.agent);
        if (this.client && this.sessionId) await this.client.switchAgent(this.sessionId, msg.agent);
        return;
      case "setAutoApprove":
        return this.setAutoApprove(msg.enabled);
      case "saveDraft":
        return this.saveDraft(msg.sessionId, msg.text);
      case "permissionReply": {
        const sid = msg.sessionId;
        const generation = this.executionGen.current();
        try {
          await this.client?.replyPermission(sid, msg.requestId, msg.decision);
          // Rejecting a tool call ends the assistant's turn: stop the generation too, otherwise
          // the model keeps answering and the composer stays on "stop" with no card left to act on.
          // "once" and "always" let the turn continue as usual.
          if (msg.decision === "reject" && this.client && sid) {
            try {
              await this.client.interrupt(sid);
            } catch (err) {
              this.output.warn(`[chat] interrupt after permission reject failed: ${String(err)}`);
            }
          }
        } finally {
          if (msg.decision === "reject") this.postLocalIdle(sid, generation);
        }
        return;
      }
      case "formReply":
        await this.client?.replyForm(msg.sessionId, msg.formId, msg.answer);
        return;
      case "formCancel": {
        const sid = msg.sessionId;
        const generation = this.executionGen.current();
        try {
          await this.client?.cancelForm(sid, msg.formId);
          // Dismissing a question ends the assistant's turn: stop the generation too, otherwise
          // the model keeps answering and the composer stays on "stop" after the form is gone.
          // An already-idle session may reject the interrupt; the local idle below still applies.
          if (this.client && sid) {
            try {
              await this.client.interrupt(sid);
            } catch (err) {
              this.output.warn(`[chat] interrupt after form cancel failed: ${String(err)}`);
            }
          }
        } finally {
          // The server may answer with only `form.cancelled` and no terminal execution event.
          // Clear busy locally so the composer can never stay stuck on "stop" (same guard as
          // `abort`).
          this.postLocalIdle(sid, generation);
        }
        return;
      }
      case "searchFiles": {
        const items = (await this.fileIndex?.search(msg.query)) ?? [];
        this.post({ type: "fileResults", query: msg.query, items });
        return;
      }
      case "fileIcons": {
        try {
          this.post({ type: "fileIcons", ...(await this.fileIcons.resolve(msg.paths)) });
        } catch (err) {
          this.output.warn(`[chat] file icon theme: ${String(err)}`);
          // A broken theme must not make the webview retry forever: answer with explicit misses.
          this.post({ type: "fileIcons", icons: Object.fromEntries(msg.paths.map((p) => [p, null])), fonts: {} });
        }
        return;
      }
      case "dropFiles":
        return this.dropFiles(msg.files);
      case "pickFiles":
        return this.pickFiles();
      case "openDiff":
        if (this.folder) await this.diffs.open(this.folder.uri, msg.file, msg.patch, msg.applied);
        return;
      case "openDiffs":
        // Only the changed hunks, in one read-only VS Code diff view (no files involved).
        await this.diffs.openCombined(msg.files);
        return;
      case "openFile":
        return this.openFile(msg.path);
      case "openLink":
        return this.openLink(msg.href);
      case "copy":
        await vscode.env.clipboard.writeText(msg.text);
        return;
      case "action":
        return this.runAction(msg.id);
      case "selectFolder":
        return this.switchFolder(vscode.workspace.workspaceFolders?.find((f) => f.uri.toString() === msg.uri));
      case "refreshChanges":
        return void (await this.refreshChanges());
      case "sync":
        return this.syncNow();
      case "refreshSubagent":
        // The card was expanded but its live events may have been missed; fetch the child's history.
        return void (await this.loadSubagentSnapshot(msg.sessionId));
      case "compact":
        return this.compact();
      case "dismissCompatibility":
        await this.ctx.globalState.update(COMPAT_DISMISSED_KEY, msg.version);
        return;
      case "dismissContract":
        await this.ctx.globalState.update(CONTRACT_DISMISSED_KEY, msg.signature);
        this.postConnection();
        return;
    }
  }

  private async send(text: string, attachments: Attachment[], context: ContextItem[], delivery?: "steer" | "queue"): Promise<void> {
    // A queued message starts no turn yet: leave the current turn's reconcile generation alone.
    if (delivery !== "queue") this.executionGen.bump();
    if (delivery !== "queue" && this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (!this.client) await this.connect();
    const client = this.client;
    if (!client || !this.folder) throw new Error(translatedStrings()["error.connectionLost"]);
    const files: FileAttachment[] = [];
    const seen = new Set<string>();
    // An external server cannot stat our local `file:` URIs, so those attachments are sent inline.
    const externalServer = this.server instanceof ExternalServer;
    for (const item of [...context, ...attachments]) {
      if (seen.has(item.uri)) continue;
      seen.add(item.uri);
      const resolved = await resolveAttachment(item, externalServer, mimeFromName);
      if (resolved.status === "tooLarge") {
        this.noticeTooLarge(resolved.name);
        continue;
      }
      if (resolved.status === "unreadable") {
        this.noticeUnreadable(resolved.name, resolved.detail);
        continue;
      }
      files.push(resolved.attachment);
    }
    try {
      if (!this.sessionId) {
        const permissions = vscode.workspace
          .getConfiguration("opencode", this.folder.uri)
          .get<PermissionRule[]>("sessionPermissions", DEFAULT_SESSION_PERMISSIONS);
        const autoApprove = this.permissions.takePending();
        const generation = this.loadGen.bump();
        const info = await client.createSession({
          directory: this.folder.uri.fsPath,
          agent: this.catalog.selectedAgent,
          model: this.catalog.selectedModel,
          permissions,
        });
        if (autoApprove !== undefined) {
          await this.permissions.write(info.id, autoApprove);
        }
        await this.loadSession(info, () => !this.loadGen.is(generation));
        if (!this.loadGen.is(generation)) return;
      }
      const sid = this.sessionId;
      if (!sid) return;
      const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      const command = slash && this.catalog.commands.find((c) => c.name === slash[1]);
      // A steer replaces the current answer: interrupt first, then send with the server's
      // steering delivery so OpenCode skips the rest of the old turn.
      if (delivery === "steer") await client.interrupt(sid).catch(() => false);
      if (command && slash) {
        await client.command(sid, command.name, (slash[2] ?? "").trim(), files, delivery);
      } else {
        await client.prompt(sid, text, files, delivery);
      }
    } catch (err) {
      const s = translatedStrings();
      const detail = err instanceof Error ? err.message : String(err);
      this.post({ type: "notice", error: { kind: "promptFailed", message: s["error.promptFailed"], detail, actions: ["reconnect", "showLogs"] } });
    }
  }

  private async openFile(p: string): Promise<void> {
    if (!this.folder) return;
    const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(p);
    const file = m?.[1] ?? p;
    const line = m?.[2] ? Number(m[2]) - 1 : undefined;
    const uri = file.startsWith("file:")
      ? vscode.Uri.parse(file)
      : /^([a-zA-Z]:[\\/]|\/)/.test(file)
        ? vscode.Uri.file(file)
        : vscode.Uri.joinPath(this.folder.uri, file);
    // Rendered chat content is untrusted model output. Never open a path outside the workspace,
    // even if a crafted link or `../` sequence makes it through the webview's sanitizer.
    const root = path.resolve(this.folder.uri.fsPath);
    const target = path.resolve(uri.fsPath);
    const lowerRoot = process.platform === "win32" ? root.toLowerCase() : root;
    const lowerTarget = process.platform === "win32" ? target.toLowerCase() : target;
    if (lowerTarget !== lowerRoot && !lowerTarget.startsWith(lowerRoot + path.sep)) {
      this.output.warn(`[chat] blocked an attempt to open a file outside the workspace: ${target}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri.with({ query: "" }));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async openLink(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    await this.openFile(href.replace(/^\.\//, "").replace(/#L(\d+).*$/, ":$1"));
  }

  async dispose(): Promise<void> {
    this.stream?.close();
    this.serverSub?.();
    this.fileIndex?.dispose();
    this.stopLivePoll();
    this.clearTimers();
    for (const d of this.disposables) d.dispose();
  }

  // Exposed for integration tests.
  get debugState() {
    const storedSession = this.folder ? this.ctx.workspaceState.get<string>(SESSION_KEY(this.folder.uri.toString())) : undefined;
    return { status: this.status, sessionId: this.sessionId, storedSession, folder: this.folder?.uri.fsPath, baseUrl: this.client?.conn.baseUrl };
  }
}
