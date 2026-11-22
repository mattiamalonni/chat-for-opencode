import * as path from "node:path";
import * as vscode from "vscode";
import { ApiError, OpenCodeClient, type Connection, type PermissionRule } from "../client/http";
import { CatalogService } from "./catalogService";
import { ConnectionSupervisor } from "./connectionSupervisor";
import { FileIconThemeService, type LanguageContribution } from "./fileIconTheme";
import { ChatLifecycle } from "./lifecycle";
import { describeServerError, ExternalServer, ManagedServer, ServerError, type ServerHandle, type ServerState } from "../server/server";
import type {
  AgentInfo,
  ConfigEntry,
  FileAttachment,
  FileDiff,
  FormRequest,
  InboxItem,
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
import { eventSessionId, sessionIsBusy } from "../shared/chatReducer";
import { parseSubagentReport } from "../shared/subagentReport";
import { checkCompatibility } from "../shared/compatibility";
import { DEFAULT_STARTUP_TIMEOUT_MS, jitteredDelay } from "../shared/constants";
import { checkContract, contractSignature, emptyContract, type ContractObservations } from "../shared/contract";
import { isWebviewMessage } from "../shared/protocolGuards";
import type {
  ActionId,
  Attachment,
  ConnectionStatus,
  ContextItem,
  DroppedFile,
  HostMessage,
  UiError,
  UiErrorKind,
  WebviewMessage,
} from "../shared/protocol";
import { STRINGS, type Strings } from "../shared/strings";
import { resolveAttachment } from "./attachments";
import { AttachmentService, mimeFromName } from "./attachmentService";
import { SessionListService, type SessionSearchResult } from "./sessionListService";
import { SubagentTracker } from "./subagentTracker";
import { ContextTracker, FileIndex, selectionAttachment } from "./context";
import { ChatViews, type ChatWebview } from "./views";
import { DiffService } from "./diff";
import { DEFAULT_SESSION_PERMISSIONS } from "./permissions";
import { PermissionService } from "./permissionService";
import { quoteForShell } from "./shell";
import { isWithinDirectory } from "./tempAttachments";
import { isWithinDirectoryReal } from "./pathSafety";
import { normalizeEndpoint } from "../server/endpoint";
import { configTargetPaths } from "./configTarget";
import { ExecutionStateService, type ExecutionState } from "./executionState";

export type { ExecutionState, ExecutionStatus, TerminalStatus } from "./executionState";

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

export type { SessionSearchResult } from "./sessionListService";

let cachedStrings: Strings | undefined;
/** Locale and the string table are static for a session: translate once, not on every error/reconnect. */
export function translatedStrings(): Strings {
  return (cachedStrings ??= Object.fromEntries(Object.entries(STRINGS).map(([k, v]) => [k, vscode.l10n.t(v)])) as Strings);
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
      const endpoint = normalizeEndpoint(cfg.get<string>("endpoint", "").trim());
      server = endpoint.baseUrl
        ? new ExternalServer({
            folder: folder.uri.fsPath,
            endpoint: endpoint.baseUrl,
            // Credentials in userinfo are a fallback; an explicitly stored password wins.
            getPassword: async () => (await this.secrets.get(PASSWORD_KEY(endpoint.baseUrl))) ?? endpoint.password,
            log: this.log,
          })
        : new ManagedServer({
            folder: folder.uri.fsPath,
            executable: cfg.get<string>("executablePath", "opencode").trim() || "opencode",
            startupTimeoutMs: cfg.get<number>("startupTimeout", DEFAULT_STARTUP_TIMEOUT_MS),
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
        return {
          kind: "notInstalled",
          message: s["error.notInstalled"],
          detail: err.detail ?? err.message,
          actions: ["install", "openSettings", "showLogs"],
        };
      case "unauthorized":
        return { kind: "unauthorized", message: s["error.unauthorized"], detail: err.message, actions: ["setPassword", "openSettings"] };
      case "unreachable":
        return {
          kind: "connectionLost",
          message: s["error.connectionLost"],
          detail: err.detail ?? err.message,
          actions: ["reconnect", "openSettings", "showLogs"],
        };
      default:
        return {
          kind: "startFailed",
          message: s["error.startFailed"],
          detail: [err.message, err.detail].filter(Boolean).join("\n"),
          actions: ["reconnect", "showLogs", "openSettings"],
        };
    }
  }
  if (err instanceof ApiError && err.status === 401) {
    return { kind: "unauthorized", message: s["error.unauthorized"], detail: err.message, actions: ["setPassword", "reconnect"] };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: fallback, message: s[`error.${fallback}`], detail: message, actions: ["reconnect", "showLogs"] };
}

export class ChatController implements vscode.Disposable {
  /** All live chats and their listeners; see views.ts. */
  private readonly chatViews: ChatViews;
  private folder: vscode.WorkspaceFolder | undefined;
  /** Server process, HTTP client and SSE stream ownership; see connectionSupervisor.ts. */
  private readonly supervisor: ConnectionSupervisor;
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
  /** All in-flight tokens and timers live in one place; see lifecycle.ts. */
  private readonly lifecycle = new ChatLifecycle();
  /** Single owner of turn status, generation and local-idle grace; see executionState.ts. */
  private readonly execution = new ExecutionStateService();
  /** Picker paging, summaries, fork visibility and bounded search; see sessionListService.ts. */
  private readonly sessionList: SessionListService;
  /** High-water mark for incremental resync: the newest history message id of the loaded session. */
  private lastKnownMessage: { sessionId: string; id: string } | undefined;
  /** A failed catalog fetch is retried a couple of times before the banner asks the user to reconnect. */
  private catalogRetries = 0;
  /** Last live SSE event for the open session; a poll is redundant while the stream feeds us. */
  private lastSessionEventAt = 0;
  /** Child discovery, event routing and snapshots; see subagentTracker.ts. */
  private readonly subagents: SubagentTracker;

  /** Drops, picker, inline staging and the attachment path allowlist; see attachmentService.ts. */
  private readonly attachments: AttachmentService;
  /** Attention requests already announced while the chat was hidden (avoids notification spam). */
  private readonly announcedHiddenAttention = new Set<string>();

  // The supervisor owns these; the controller reads them through the same names it always used.
  private get client(): OpenCodeClient | undefined {
    return this.supervisor.currentClient;
  }

  private get server(): ServerHandle | undefined {
    return this.supervisor.currentServer;
  }

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    registry: ServerRegistry,
    private readonly diffs: DiffService,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.chatViews = new ChatViews(
      ctx.extensionUri,
      (msg) => void this.receive(msg),
      () => {
        // Back in view: the user can see the cards, so a later resync must not announce them again.
        this.announcedHiddenAttention.clear();
        // `resync()` also publishes a "connected" status, so never run it while still connecting.
        if (this.status === "connected" && this.client) void this.resync();
      },
    );
    this.supervisor = new ConnectionSupervisor({
      registry,
      log: (line) => output.info(line),
      getFolder: () => this.folder,
      setFolder: (folder) => {
        this.folder = folder;
      },
      pickFolder: () => this.pickFolder() as vscode.WorkspaceFolder,
      trustBlocked: () => this.trustBlocked(),
      postUntrusted: () => this.postUntrusted(),
      setStatus: (status, error) => this.setStatus(status, error),
      getStatus: () => this.status,
      generation: this.lifecycle.generations.connect,
      onReady: (conn, version, stale) => {
        this.version = version;
        return this.useConnection(conn, stale);
      },
      onStreamReconnect: () => {
        void this.resync();
      },
      onDetached: () => {
        this.lastKnownMessage = undefined;
        this.stopLivePoll();
        this.clearTimers();
      },
      toUiError: (err, fallback) => {
        // Child-process output is diagnostic-only: redacted by the server, capped, and written here
        // instead of being forwarded to the webview as an error detail.
        if (err instanceof ServerError && err.logDetail) output.warn(`[server] ${err.logDetail}`);
        return toUiError(err, fallback);
      },
    });
    this.attachments = new AttachmentService(
      (item) => this.addAttachment(item),
      (kind, name, detail) => (kind === "tooLarge" ? this.noticeTooLarge(name) : this.noticeUnreadable(name, detail)),
      (line) => output.warn(line),
      (editor, line) => this.revealLine(editor, line),
    );
    this.subagents = new SubagentTracker(
      () => this.client,
      () => this.sessionId,
      () => this.folder?.uri.fsPath,
      this.lifecycle.generations.child,
      (msg) => this.post(msg),
      (line) => output.warn(line),
      (client, childId, requests, autoApprove) => this.permissions.filterPending(client, childId, requests, autoApprove),
      () => this.autoApproveEnabled(),
    );
    this.sessionList = new SessionListService(
      () => this.client,
      () => this.folder?.uri.fsPath,
      () => this.sessionId,
      this.lifecycle.generations.sessions,
      (msg) => this.post(msg),
      (line) => output.warn(line),
      () => {
        const configured = vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<number>("sessionPageSize", 10);
        return Math.min(100, Math.max(1, Math.floor(configured) || 10));
      },
    );
    this.context = new ContextTracker((items) => this.post({ type: "context", items }));
    this.permissions = new PermissionService(
      ctx,
      () => this.folder,
      (line) => output.info(line),
    );
    this.catalog = new CatalogService(
      ctx,
      (msg) => this.post(msg),
      (line) => output.info(line),
      () => this.chatViews.size > 0,
    );
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

  attachView(view: ChatWebview): void {
    this.chatViews.attachView(view);
  }

  attachPanel(panel: vscode.WebviewPanel): void {
    this.chatViews.attachPanel(panel);
  }

  openChatInEditor(): void {
    this.chatViews.openChatInEditor();
  }

  /** Search session titles and message bodies across the workspace (delegated to the picker service). */
  async searchSessions(query: string, maxSessions = 200): Promise<SessionSearchResult[]> {
    // A new query supersedes the previous one; do not leave its history fetches running.
    this.sessionList.cancelSearch();
    return this.sessionList.search(query, maxSessions);
  }

  /** Opens the session a search hit came from and asks the webview to scroll to its message. */
  async openSearchResult(result: SessionSearchResult): Promise<void> {
    await vscode.commands.executeCommand("opencode.chatView.focus");
    if (result.sessionId !== this.sessionId) await this.receive({ type: "selectSession", id: result.sessionId });
    if (result.messageId) this.post({ type: "revealMessage", messageId: result.messageId, sessionId: result.sessionId });
  }

  /** Fills the composer from an editor context action, attaching the selection it came from. */
  prefillDraft(text: string, attachments: Attachment[]): void {
    this.post({ type: "prefillDraft", sessionId: this.sessionId ?? undefined, text, attachments });
  }

  /** Serializes webview messages: a late `ready`/loadAll must not race a prompt and drop its events. */
  private messageQueue: Promise<unknown> = Promise.resolve();

  /** The last prompt the server refused, kept so the "Retry" action can resend the exact payload. */
  private failedPrompt?: {
    text: string;
    attachments: Attachment[];
    context: ContextItem[];
    delivery?: "steer" | "queue";
    sessionId?: string;
  };

  /**
   * Entry point for webview messages (also used by integration tests).
   *
   * The webview is untrusted input from the host's point of view: validate at the boundary before
   * anything reaches `handle()`, which dispatches privileged actions (file/terminal/link opening,
   * session deletion). Messages that do not match the protocol are logged and dropped, never
   * dispatched with whatever shape the sender happened to choose.
   */
  async receive(msg: unknown): Promise<void> {
    if (!isWebviewMessage(msg)) {
      const type = typeof msg === "object" && msg !== null ? (msg as { type?: unknown }).type : typeof msg;
      this.output.warn(`[chat] ignored an invalid webview message (type: ${String(type)})`);
      return;
    }
    const run = this.messageQueue.then(() => this.handle(msg));
    // Keep the chain alive after a failed message so later ones are still processed.
    this.messageQueue = run.catch(() => undefined);
    try {
      await run;
    } catch (err) {
      this.output.error(`[chat] ${msg.type} failed: ${String(err)}`);
      if (err instanceof ServerError && err.logDetail) this.output.warn(`[server] ${err.logDetail}`);
      const error = toUiError(err);
      // No `*.replied` event arrives for a failed reply, so tag the notice with the card it
      // belongs to; the webview uses it to re-enable the card's buttons for a retry.
      if (msg.type === "permissionReply") error.target = { kind: "permission", id: msg.requestId };
      else if (msg.type === "formReply" || msg.type === "formCancel") error.target = { kind: "form", id: msg.formId };
      this.post({ type: "notice", error });
    }
  }

  get isVisible(): boolean {
    return this.chatViews.isVisible;
  }

  post(msg: HostMessage): void {
    this.chatViews.post(msg);
  }

  /** Best-effort fetches degrade to a fallback, but the reason must still reach the output channel. */
  private async bestEffort<T>(label: string, promise: Promise<T>, fallback: T): Promise<T> {
    try {
      return await promise;
    } catch (err) {
      this.output.warn(`[chat] ${label} failed: ${describeServerError(err)}`);
      return fallback;
    }
  }

  /**
   * Host-side execution state, for the status bar and completion notifications. Deliberately
   * separate from `post()`: the webview already receives events, the editor chrome does not.
   */
  onDidChangeExecution(listener: (state: ExecutionState) => void): vscode.Disposable {
    const sub = this.execution.onDidChange(listener);
    return new vscode.Disposable(() => sub.dispose());
  }

  /** Observes messages sent to the webview (used by integration tests). */
  onDidPost(listener: (msg: HostMessage) => void): vscode.Disposable {
    return this.chatViews.onDidPost(listener);
  }

  /**
   * Marks a session idle in the webview without waiting for a server terminal event. OpenCode can
   * end a turn (a second interrupt, a dismissed question) without emitting one, which would leave
   * the composer stuck on "stop" forever.
   */
  private postLocalIdle(sid: string, generation = this.execution.current()): void {
    // Ignore late results: a newer prompt may have started while interrupt/cancel was in flight.
    if (sid !== this.sessionId || !this.execution.markLocalIdle(sid, generation)) return;
    this.post({
      type: "event",
      // `local` tells the webview to also finish the partial assistant message and its turn: the
      // server emits no terminal event in these cases, so nothing else would close the streaming
      // card (shimmer + disabled copy button forever).
      event: { type: "session.status", data: { sessionID: sid, status: { type: "idle", local: true } } } as ServerEvent,
    });
    // The server may emit no terminal event for a local idle, and `onEvent` is the only other
    // place that refreshes the list and replaces the partial message with server history.
    this.scheduleSessions();
    this.scheduleReconcile();
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

  /**
   * An untrusted workspace must never start a configurable executable or read stored credentials.
   * VS Code returns restricted configuration defaults there, but `ensure()` would still spawn the
   * default `opencode` binary, so the gate belongs before any server/secret access.
   */
  private trustBlocked(): boolean {
    return !vscode.workspace.isTrusted;
  }

  private postUntrusted(): void {
    const s = translatedStrings();
    this.setStatus("error", {
      kind: "untrustedWorkspace",
      message: s["error.untrustedWorkspace"],
      actions: ["trustWorkspace"],
    });
  }

  /** Reacts to the user trusting (or untrusting) the current window without requiring a reload. */
  async onWorkspaceTrustChanged(trusted: boolean): Promise<void> {
    if (trusted) {
      if (this.chatViews.hasPrimary) await this.connect();
      return;
    }
    await this.detachServers();
    this.postUntrusted();
  }

  /** Starts (or reuses) the server for the current folder and loads everything. */
  connect(): Promise<void> {
    return this.supervisor.connect();
  }

  /** Integration-test hook for late server notifications (see extension.test.ts). */
  onServerState(state: ServerState, server?: ServerHandle): void {
    this.supervisor.onServerState(state, server);
  }

  /**
   * Installs a connection owned by the supervisor, then loads chat state from it. A failed load
   * leaves the client installed but *not* marked loaded, so the next reconnect retries instead of
   * hitting the "same connection" no-op guard.
   */
  private async useConnection(conn: Connection, isStale: () => boolean = () => false): Promise<void> {
    if (isStale()) return;
    if (this.trustBlocked()) {
      this.postUntrusted();
      return;
    }
    if (this.supervisor.matches(conn)) return;
    this.supervisor.clearLoaded();
    this.catalog.resetWarmUp();
    this.fileIndex?.dispose();
    this.fileIndex = this.folder ? new FileIndex(this.folder, this.ctx.workspaceState) : undefined;
    this.supervisor.openStream(
      conn,
      (event) => this.onEvent(event as ServerEvent),
      (status, error) => this.supervisor.onStreamStatus(status, error),
    );
    await this.loadAll();
    this.supervisor.markLoaded(conn);
    this.startLivePoll();
  }

  private async loadAll(): Promise<void> {
    const client = this.client;
    if (!client || !this.folder) return;
    const generation = this.lifecycle.generations.load.bump();
    const stale = () => !this.lifecycle.generations.load.is(generation);
    this.contractObservations = {};
    this.contract = emptyContract;
    let catalogError: string | undefined;
    const [models, defaultModel, agents] = await Promise.all([
      client.models().catch((err: unknown) => {
        catalogError = err instanceof Error ? err.message : String(err);
        this.output.warn(`[chat] failed to load models: ${catalogError}`);
        return [] as ModelInfo[];
      }),
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
      session = await this.bestEffort("load stored session", client.getSession(sessionId), undefined);
      if (stale()) return;
    }
    // Plugin skills/commands are registered only once a session exists. With no session yet
    // (fresh window, or right after "New session") create a throwaway one so the `/` picker is
    // populated before the first prompt; the registrations survive deleting that session.
    if (!session && !this.catalog.isWarmedUp) {
      const tmp = await this.bestEffort("create warm-up session", client.createSession({ directory: this.folder.uri.fsPath }), undefined);
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
      this.subagents.reset();
      this.catalog.publish();
      this.post({ type: "session", session: null });
      this.postAutoApprove();
    }
    if (catalogError !== undefined) {
      // An empty array from a *failed* request is not evidence that the user has no provider.
      const s = translatedStrings();
      this.setStatus("error", {
        kind: "requestFailed",
        message: s["error.requestFailed"],
        detail: catalogError,
        actions: ["reconnect", "showLogs"],
      });
      if (this.catalogRetries < 2 && !stale()) {
        this.catalogRetries++;
        const wait = jitteredDelay(500 * this.catalogRetries);
        this.lifecycle.schedule(
          "catalogRetry",
          () => {
            if (!stale()) void this.loadAll();
          },
          wait,
        );
      }
    } else {
      this.catalogRetries = 0;
      if (this.catalog.models.length === 0) {
        const s = translatedStrings();
        this.setStatus("error", { kind: "noProvider", message: s["error.noProvider"], actions: ["login", "reconnect", "showLogs"] });
      } else {
        this.setStatus("connected");
      }
    }
    this.post({ type: "context", items: this.context.current() });
  }

  /** OpenCode registers plugin catalog items only once a session exists; keep the picker fresh. */
  private async refreshSlashItems(): Promise<void> {
    if (this.client) await this.catalog.refresh(this.client);
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
    void this.refreshInbox(sid).catch(() => {});
    return true;
  }

  /** Live stream has no replay: re-fetch the current session after a reconnect. */
  private async resync(): Promise<void> {
    try {
      const generation = this.lifecycle.generations.load.current();
      // `resync()` is fire-and-forget from the stream status and view visibility handlers. Capture
      // the connection too: a folder switch or a new connect during the awaits below must not let an
      // old resync publish "connected" for a client we no longer own.
      const connectGeneration = this.lifecycle.generations.connect.current();
      const client = this.client;
      const sid = this.sessionId;
      await this.refreshSessions();
      if (sid && sid === this.sessionId && client && client === this.client) {
        const info = await client.getSession(sid);
        if (!this.lifecycle.generations.load.is(generation) || sid !== this.sessionId || client !== this.client) return;
        const busyOverride = this.execution.isLocallyIdle(sid) ? false : undefined;
        const stale = () => !this.lifecycle.generations.load.is(generation) || sid !== this.sessionId || client !== this.client;
        if (!(await this.resyncTail(sid, info, stale, busyOverride))) {
          await this.loadSession(info, stale, busyOverride);
        }
      }
      if (!this.lifecycle.generations.connect.is(connectGeneration) || client !== this.client) return;
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
      const generation = this.lifecycle.generations.load.bump();
      const info = await client.getSession(sid);
      if (!this.lifecycle.generations.load.is(generation) || sid !== this.sessionId) return;
      await this.loadSession(info, () => !this.lifecycle.generations.load.is(generation) || sid !== this.sessionId);
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
    this.lifecycle.startInterval("livePoll", () => void this.pollSessionTail(), LIVE_POLL_MS);
  }

  private stopLivePoll(): void {
    this.lifecycle.stopInterval("livePoll");
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
      const generation = this.lifecycle.generations.load.current();
      const stale = () => !this.lifecycle.generations.load.is(generation) || sid !== this.sessionId;
      // The tail itself is authoritative. `time.updated` is not a reliable gate: it can stay equal
      // on a coarse clock, or move for changes we do not render, which used to hide real messages.
      const newer = await client.messagesNewerThan(sid, head.id).catch(() => undefined);
      if (stale()) return;
      if (newer === undefined) {
        // `messagesNewerThan` looks at the newest page only. A burst of >200 messages from another
        // client (or a compacted history) has no overlap with our mark: fall back to a full load.
        // `getSession()` also gates transient tail failures — if the server is really down it throws
        // and the catch below logs, so a broken poll cannot rebuild the chat every two seconds.
        const info = await client.getSession(sid);
        if (stale()) return;
        await this.loadSession(info, stale, this.execution.isLocallyIdle(sid) ? false : undefined);
        void this.refreshSessions().catch(() => {});
        return;
      }
      if (newer.length === 0) return;
      const info = await client.getSession(sid);
      if (stale()) return;
      const busyOverride = this.execution.isLocallyIdle(sid) ? false : undefined;
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

  /** Exposed for integration tests: force the reconnect-style resync without touching VS Code UI. */
  resyncNow(): Promise<void> {
    return this.resync();
  }

  // ---- subagents --------------------------------------------------------------------------

  /**
   * A child has no separate toggle of its own: it inherits the chat's auto-approve choice. Without
   * this, a permission asked by a subagent would stay pending forever — the child session is not
   * `this.sessionId`, so `PermissionService.enabled(childId)` would fall back to the global setting
   * even when the user explicitly turned auto-approve on (or off) for this chat.
   */
  private autoApproveEnabled(): boolean {
    return this.permissions.enabled(this.sessionId);
  }

  /** Post a live event to the session that owns it: the main chat, or a tracked subagent's view. */
  private postSessionEvent(sid: string, event: ServerEvent): void {
    this.subagents.postEvent(sid, event);
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
        this.subagents.setParent(data.sessionID, data.parentID);
        if (this.subagents.isTracked(data.sessionID)) {
          this.subagents.track(data.sessionID, data);
        }
      }
    }
    if (
      sid === this.sessionId &&
      (event.type === "session.tool.progress" || event.type === "session.tool.success" || event.type === "session.tool.failed")
    ) {
      const data = event.data as { id?: unknown; metadata?: { sessionID?: unknown } };
      const childId = data.metadata?.sessionID;
      if (typeof childId === "string" && childId) {
        this.subagents.track(childId);
        // Link by tool call id, not by title: two concurrent subagents can share a description, and
        // the tool card may be created after this event. The webview keeps the id until it appears.
        if (typeof data.id === "string" && data.id) this.post({ type: "linkSubagent", toolId: data.id, sessionId: childId });
      }
    }
    if (sid === this.sessionId && event.type === "session.inbox.enqueued") {
      // A background child announces its final report after the parent turn has already ended.
      // Re-read its history now: that is when the steps and the report are actually complete.
      const item = (event.data as { item?: { type?: string; payload?: { text?: string } } }).item;
      const parsed = item?.type === "synthetic" ? parseSubagentReport(item.payload?.text) : undefined;
      if (parsed && this.sessionId) {
        this.subagents.setParent(parsed.sessionId, this.sessionId);
        if (this.subagents.hasChild(parsed.sessionId)) void this.subagents.snapshot(parsed.sessionId);
        else this.subagents.track(parsed.sessionId);
      }
    }
    if (
      sid === this.sessionId &&
      (event.type === "session.inbox.enqueued" ||
        event.type === "session.inbox.delivered" ||
        event.type === "session.inbox.cancelled" ||
        event.type === "session.inbox.delivery.changed")
    ) {
      this.scheduleInbox();
    }
    if (event.type === "session.deleted" && sid && this.subagents.hasChild(sid)) {
      this.subagents.forget(sid);
    }
    if (event.type === "permission.replied") {
      const requestId = (event.data as { requestID?: string }).requestID;
      if (requestId) this.permissions.forgetRequest(requestId);
      this.announcedHiddenAttention.delete(`permission.asked:${requestId}`);
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      this.announcedHiddenAttention.delete(`form.created:${(event.data as { id?: string }).id}`);
    }
    // Plugin skills/commands can be registered or removed while the chat is open.
    if (event.type === "skill.updated" || event.type === "command.updated") void this.refreshSlashItems();
    // Bypass the inline card: grant each request on arrival instead of asking the user. Children
    // are included — otherwise a subagent's `ask` permission would block with no card to act on.
    if (event.type === "permission.asked" && sid && this.subagents.isTracked(sid) && this.autoApproveEnabled()) {
      void this.autoApprove(event, sid);
      return;
    }
    if (sid) this.postSessionEvent(sid, event);
    // One owner for turn starts and terminals: it invalidates deferred work, ends the local-idle
    // grace period and publishes the host status. Terminal events are reported back to us below.
    const terminalStatus = this.execution.observe(event.type, sid, this.sessionId);
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
    if (terminalStatus) {
      const status = terminalStatus;
      this.scheduleReconcile();
      // A resync can replay the same terminal event, so include the turn's generation in the key.
      const key = `execution.terminal:${sid}:${this.execution.generation.current()}`;
      if (!this.isVisible && !this.announcedHiddenAttention.has(key)) {
        const cfg = vscode.workspace.getConfiguration("opencode", this.folder?.uri);
        const enabled = status === "failed" ? cfg.get<boolean>("notifyOnFailure", true) : cfg.get<boolean>("notifyOnComplete", false);
        if (enabled) {
          this.announcedHiddenAttention.add(key);
          const message =
            status === "failed"
              ? vscode.l10n.t("OpenCode turn failed.")
              : status === "interrupted"
                ? vscode.l10n.t("OpenCode turn was interrupted.")
                : vscode.l10n.t("OpenCode turn finished.");
          const open = vscode.l10n.t("Open chat");
          void vscode.window.showInformationMessage(message, open).then((choice) => {
            if (choice === open) void vscode.commands.executeCommand("opencode.chatView.focus");
          });
        }
      }
    }
    if (event.type === "session.deleted" && sid === this.sessionId) {
      void this.newSession();
    }
    if (sid === this.sessionId && event.type === "session.step.ended") {
      const files = (event.data as { files?: string[] }).files;
      if (files && files.length > 0) this.scheduleChanges();
    }
    if (sid && this.subagents.isTracked(sid) && (event.type === "permission.asked" || event.type === "form.created") && !this.isVisible) {
      const id =
        event.type === "permission.asked" ? (event.data as { id?: string }).id : (event.data as { form?: { id?: string } }).form?.id;
      const key = `${event.type}:${id}`;
      // A resync re-posts the same pending request; announce it only once, not on every event.
      if (id && !this.announcedHiddenAttention.has(key)) {
        this.announcedHiddenAttention.add(key);
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
  }

  /** Cancel all deferred work from the previous connection/session before switching or resetting. */
  private clearTimers(): void {
    this.lifecycle.clearAll();
    this.catalogRetries = 0;
  }

  private postAutoApprove(): void {
    this.post({ type: "autoApprove", enabled: this.permissions.enabled(this.sessionId) });
  }

  /** Drafts live in workspaceState so they survive a window reload (vscode.setState does not). */
  private postDrafts(): void {
    if (!this.folder) return;
    const saved = this.ctx.workspaceState.get<{ drafts?: Record<string, string>; globalDraft?: string }>(
      DRAFTS_KEY(this.folder.uri.toString()),
    );
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
      // The grant failed: show the card in the session that owns the request, main chat or child.
      this.postSessionEvent(sessionId, event);
      return;
    }
    this.output.info(`[chat] auto-approved ${request.action} (${sessionId})`);
  }

  /** Grants requests that were already pending when auto-approval was turned on, in children too. */
  private async approvePending(): Promise<void> {
    const client = this.client;
    const sid = this.sessionId;
    if (!client || !sid || !this.autoApproveEnabled()) return;
    for (const id of [sid, ...this.subagents.ids()]) {
      const pending = await client.permissions(id).catch(() => [] as PermissionRequest[]);
      for (const request of pending) {
        if (!(await this.permissions.approveOnce(client, id, request.id))) {
          // The grant failed: make sure a card is shown instead of silently leaving the agent blocked.
          this.postSessionEvent(id, { type: "permission.asked", data: request });
        }
      }
    }
  }

  private scheduleSessions(): void {
    this.lifecycle.schedule("sessions", () => void this.refreshSessions().catch(() => {}), 250);
  }

  private scheduleChanges(): void {
    this.lifecycle.schedule("changes", () => void this.refreshChanges().catch(() => {}), 400);
  }

  /** Enqueue/deliver/cancel events arrive in bursts; one refresh per burst is enough. */
  private scheduleInbox(): void {
    this.lifecycle.schedule("inbox", () => void this.refreshInbox().catch(() => {}), 150);
  }

  /**
   * Re-read the pending prompts from the server. A queued message is stored server-side, so the
   * webview cannot reconstruct the list from the SSE events (which carry no replay).
   */
  private async refreshInbox(sid = this.sessionId): Promise<void> {
    const client = this.client;
    if (!client || !sid || sid !== this.sessionId) return;
    const items = await client.inbox(sid).catch(() => [] as InboxItem[]);
    if (sid !== this.sessionId || client !== this.client) return;
    this.publishInbox(items);
  }

  private publishInbox(items: InboxItem[]): void {
    this.post({ type: "inbox", items });
  }

  /**
   * The event stream is live-only, so a missed terminal event can leave the webview showing an
   * incomplete turn forever. After each turn, re-read the session and replace the webview state.
   * Skipped when another prompt starts meanwhile, since its live events are newer than the snapshot.
   */
  private scheduleReconcile(): void {
    const sid = this.sessionId;
    const generation = this.execution.generation.current();
    this.lifecycle.schedule(
      "reconcile",
      () => {
        if (!sid || sid !== this.sessionId || !this.execution.generation.is(generation)) return;
        void this.reconcileSession(sid, generation);
      },
      350,
    );
  }

  private async reconcileSession(sid: string, generation: number): Promise<void> {
    if (!this.client || sid !== this.sessionId) return;
    try {
      const info = await this.client.getSession(sid);
      if (sid !== this.sessionId || !this.execution.generation.is(generation)) return;
      // If the composer was cleared locally and no new turn has started, the server's timestamps
      // are stale (a dismissed question can leave `busy` newer than `idle` with no idle message).
      // Keep it unlocked instead of re-syncing back to "stop".
      const busyOverride = this.execution.isLocallyIdle(sid) ? false : undefined;
      const stale = () => sid !== this.sessionId || !this.execution.generation.is(generation);
      if (!(await this.resyncTail(sid, info, stale, busyOverride))) {
        await this.loadSession(info, stale, busyOverride);
      }
    } catch (err) {
      // A failed reconcile is not worth surfacing: the live stream may still have delivered everything.
      this.output.warn(`[chat] session reconcile failed: ${String(err)}`);
    }
  }

  async refreshSessions(): Promise<void> {
    await this.sessionList.refresh();
  }

  async loadMoreSessions(): Promise<void> {
    await this.sessionList.loadMore();
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

    this.sessionList.forget(deleted);
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
    const sid = this.sessionId;
    const client = this.client;
    let files: FileDiff[] = [];
    if (client && sid) {
      files = normalizeList(await client.diff(sid).catch(() => [] as FileDiff[]), normalizeFileDiff);
    }
    // The fetch is async: a session switch, new chat or folder change can happen while it is in
    // flight. Posting a diff fetched for the old session would overwrite the new chat's panel.
    if (sid !== this.sessionId || client !== this.client) return files;
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

  /**
   * Roll a session back to the turn opened by `messageID`. OpenCode stages a boundary (optionally
   * restoring files), then `commit` drops the boundary message and everything after it. Public so
   * tests can exercise the flow without the native confirmation dialog.
   */
  async revertToTurn(sessionId: string, messageID: string, text: string, files: boolean): Promise<void> {
    if (await this.revertBoundary(sessionId, messageID, files)) this.post({ type: "reverted", sessionId, text });
  }

  /** Shared boundary stage/commit/reload, used by both rollback and regenerate. */
  private async revertBoundary(sessionId: string, messageID: string, files: boolean): Promise<boolean> {
    const client = this.client;
    if (!client || sessionId !== this.sessionId) return false;
    this.execution.generation.bump();
    const generation = this.lifecycle.generations.load.bump();
    try {
      // Staging is rejected while the agent loop runs, and an interrupt can acknowledge before
      // execution settles; wait for idle just like OpenCode's own rewind does.
      await client.interrupt(sessionId).catch(() => false);
      await client.waitIdle(sessionId).catch(() => undefined);
      await client.revertStage(sessionId, messageID, files);
      try {
        await client.revertCommit(sessionId);
      } catch (err) {
        // `stage` already restored the files: undo that side effect if the commit did not land.
        await client.revertClear(sessionId).catch(() => undefined);
        throw err;
      }
      if (!this.lifecycle.generations.load.is(generation) || sessionId !== this.sessionId) return false;
      const info = await client.getSession(sessionId);
      if (!this.lifecycle.generations.load.is(generation) || sessionId !== this.sessionId) return false;
      // A commit deletes messages, so a tail resync cannot detect it: rebuild from history.
      await this.loadSession(info, () => !this.lifecycle.generations.load.is(generation) || sessionId !== this.sessionId);
      return true;
    } catch (err) {
      const s = translatedStrings();
      throw new Error(`${s["error.revertFailed"]} ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /**
   * Drop the reply after `messageID` without touching files, then resend the original prompt.
   * The model/agent selection stays as the user left it, so the retry uses the current settings.
   */
  async regenerateTurn(sessionId: string, messageID: string, text: string, attachments: Attachment[]): Promise<void> {
    if (!(await this.revertBoundary(sessionId, messageID, false))) return;
    await this.send(text, attachments, [], undefined);
  }

  /**
   * Copy the conversation up to `messageID` into a new sibling session and open it. The original
   * keeps its full history and files, so unlike a rollback this is a non-destructive "what if".
   */
  async forkToTurn(sessionId: string, messageID: string): Promise<void> {
    const client = this.client;
    if (!client || sessionId !== this.sessionId) return;
    const generation = this.lifecycle.generations.load.bump();
    try {
      const info = await client.forkSession(sessionId, messageID);
      if (!this.lifecycle.generations.load.is(generation) || client !== this.client) return;
      this.sessionList.addFork(info.id);
      await this.loadSession(info, () => !this.lifecycle.generations.load.is(generation) || client !== this.client);
      if (client !== this.client) return;
      this.post({ type: "forked", sessionId: info.id, title: info.title });
    } catch (err) {
      const s = translatedStrings();
      this.post({
        type: "notice",
        error: {
          kind: "requestFailed",
          message: s["error.forkFailed"],
          detail: err instanceof Error ? err.message : String(err),
          actions: ["showLogs"],
        },
      });
    }
  }

  /**
   * `fast` is used by the first prompt: the user's text must reach the server without waiting for
   * catalog/session-list/diff round-trips. Those still run, but fire-and-forget with a generation
   * guard, so the webview is published as soon as history is available.
   */
  private async loadSession(rawInfo: SessionInfo, stale?: () => boolean, busyOverride?: boolean, fast = false): Promise<void> {
    const client = this.client;
    if (!client || !this.folder) return;
    const [rawMessages, rawPermissions, rawForms, rawInbox] = await Promise.all([
      // The other fetches degrade to empty lists; history must too. `send()` awaits loadSession
      // before posting, so a transient history error must not silently swallow the user's prompt.
      client.messages(rawInfo.id).catch((err) => {
        this.output.warn(`[chat] could not load session history: ${String(err)}`);
        return [];
      }),
      client.permissions(rawInfo.id).catch(() => []),
      client.forms(rawInfo.id).catch(() => []),
      client.inbox(rawInfo.id).catch(() => [] as InboxItem[]),
    ]);
    // A newer prompt may have started while history was loading; its events are fresher.
    if (stale?.()) return;
    this.observeContract({ messages: rawMessages, inbox: rawInbox });
    const info = normalizeSessionInfo(rawInfo) ?? rawInfo;
    const messages = normalizeList(rawMessages, normalizeSessionMessage);
    const forms = normalizeList(rawForms, normalizeForm);
    const changed = this.sessionId !== info.id;
    // Publish the new session before touching children: `loadSubagentSnapshot` captures the parent
    // synchronously and drops its result if that id no longer matches the open session. Setting it
    // afterwards made every subagent of a freshly selected session fail its own staleness guard.
    this.sessionId = info.id;
    if (changed) {
      this.subagents.reset();
      // Terminal events of the previous session cannot close its turn any more.
      this.execution.ensureSession(info.id);
    }
    const newest = messages.at(-1);
    this.lastKnownMessage = newest ? { sessionId: info.id, id: newest.id } : undefined;
    // Requests granted automatically must not linger as cards when the chat's toggle is on.
    const pending = await this.permissions.filterPending(client, info.id, normalizeList(rawPermissions, normalizePermission));
    // `filterPending` performs real HTTP calls (auto-approve). A session switch while it is in
    // flight bumps `loadGen`; without a second guard we would persist and post the stale session.
    if (stale?.()) return;
    await this.ctx.workspaceState.update(SESSION_KEY(this.folder.uri.toString()), info.id);
    // Persist the selection carried by the open session, so a reload without a session uses the
    // same model/agent. These are accepted values from the server, not an optimistic local choice.
    if (info.model && this.catalog.models.some((m) => m.id === info.model?.id && m.providerID === info.model?.providerID)) {
      this.catalog.selectModel(info.model);
    }
    if (info.agent && this.catalog.agents.some((a) => a.id === info.agent)) this.catalog.selectAgent(info.agent);
    if (!fast) {
      await this.refreshSlashItems();
      if (stale?.()) return;
    }
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
    // Past subagents have no live stream on a reload; load their history for the inline cards.
    // Track only after the `session` post: the webview clears its child state on a session switch,
    // so a snapshot posted first would be wiped by the very message that opens the new chat.
    for (const id of subagentSessionsFromMessages(messages)) this.subagents.track(id);
    // A running child has no id in its tool metadata; find it via `parentID` so a pending `ask`
    // permission is still answerable after the user switches back to this chat.
    void this.subagents.discover();
    this.postAutoApprove();
    this.publishInbox(rawInbox);
    if (fast) {
      // Not on the critical path of the first prompt. The generation guard keeps a late response
      // from overwriting state after a folder/session switch.
      const guard = stale;
      void this.refreshSlashItems().catch(() => {});
      void this.refreshSessions().catch(() => {});
      void this.refreshChanges()
        .then((diff) => {
          if (!guard?.()) this.observeContract({ diff });
        })
        .catch(() => {});
    } else {
      await this.refreshSessions();
      if (stale?.()) return;
      const diff = await this.refreshChanges();
      this.observeContract({ diff });
    }
    // Idempotent: a session opened without a connection change (e.g. after New Session + prompt)
    // still needs to follow turns started by other clients sharing the same on-disk storage.
    this.startLivePoll();
  }

  // ---- commands ---------------------------------------------------------------------------

  /** Entry point for the palette/status-bar "Ask" command: reuse the normal send pipeline. */
  async ask(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.receive({ type: "send", text: trimmed, attachments: [], context: [] });
  }

  async newSession(): Promise<void> {
    this.announcedHiddenAttention.clear();
    this.failedPrompt = undefined;
    this.lifecycle.generations.load.bump();
    this.clearTimers();
    this.execution.reset();
    // No session is open any more: polling its tail would be a no-op every two seconds until the
    // next load. Loading that session starts the poll again.
    this.stopLivePoll();
    this.sessionId = undefined;
    this.subagents.reset();
    this.lastKnownMessage = undefined;
    this.permissions.setPending(undefined);
    if (this.folder) await this.ctx.workspaceState.update(SESSION_KEY(this.folder.uri.toString()), undefined);
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.publishInbox([]);
    this.postAutoApprove();
    this.catalog.publish();
    await this.refreshSessions().catch(() => {});
    this.post({ type: "focusInput" });
  }

  async reconnect(): Promise<void> {
    if (this.trustBlocked()) {
      this.postUntrusted();
      return;
    }
    this.lifecycle.generations.load.bump();
    this.clearTimers();
    this.lastKnownMessage = undefined;
    this.stopLivePoll();
    await this.supervisor.reconnect();
  }

  /** Tears down the server/stream/client without binding a new connection. */
  private async detachServers(): Promise<void> {
    this.announcedHiddenAttention.clear();
    this.lifecycle.generations.load.bump();
    await this.supervisor.detach();
  }

  async resetServers(): Promise<void> {
    await this.detachServers();
    if (this.chatViews.hasPrimary) await this.connect();
  }

  /** The "Stop Server" command: stop for good, no immediate reconnect. The next prompt reconnects. */
  async stopServer(): Promise<void> {
    await this.detachServers();
    this.setStatus("idle");
  }

  async switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (folder?.uri.toString() === this.folder?.uri.toString()) return;
    this.announcedHiddenAttention.clear();
    this.failedPrompt = undefined;
    this.lifecycle.generations.connect.bump();
    this.lifecycle.generations.load.bump();
    this.clearTimers();
    this.sessionId = undefined;
    this.lastKnownMessage = undefined;
    this.stopLivePoll();
    // Detach the old server before connecting to the new folder: its late state notifications must
    // not race the new connection (the supervisor still re-checks ownership when it installs one).
    this.supervisor.detachServerOnly();
    this.permissions.setPending(undefined);
    this.lifecycle.generations.sessions.bump();
    this.execution.reset();
    this.sessionList.reset();
    this.folder = folder;
    this.postInit();
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.postAutoApprove();
    await this.connect();
  }

  addAttachment(item: Attachment): void {
    this.post({ type: "addAttachment", item });
  }

  private noticeTooLarge(name: string): void {
    const s = translatedStrings();
    this.post({ type: "notice", error: { kind: "requestFailed", message: s["error.attachmentTooLarge"], detail: name, actions: [] } });
  }

  private noticeUnreadable(name: string, detail: string): void {
    const s = translatedStrings();
    this.post({
      type: "notice",
      error: { kind: "requestFailed", message: s["error.attachmentUnreadable"], detail, actions: ["showLogs"] },
    });
    this.output.warn(`[chat] skipped unreadable attachment ${name}: ${detail}`);
  }

  async addFile(uri: vscode.Uri): Promise<void> {
    await this.attachments.addFile(uri);
  }

  private async dropFiles(files: DroppedFile[]): Promise<void> {
    await this.attachments.dropFiles(files);
  }

  async pickFiles(): Promise<void> {
    await this.attachments.pickFiles();
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
    const endpoint = normalizeEndpoint(
      vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<string>("endpoint", "").trim(),
    ).baseUrl;
    if (!endpoint) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "A password is only needed for an external server (setting opencode.endpoint). The managed server uses a random password automatically.",
        ),
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
        const exe =
          vscode.workspace.getConfiguration("opencode", this.folder?.uri).get<string>("executablePath", "opencode").trim() || "opencode";
        let command: string;
        try {
          command = `${quoteForShell(exe)} auth login`;
        } catch (err) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Cannot run OpenCode sign-in: {0}", err instanceof Error ? err.message : String(err)),
          );
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
      case "trustWorkspace":
        // `workspace.requestWorkspaceTrust()` is not in the 1.99 API; the built-in command opens
        // the same Workspace Trust editor with the current folder selected.
        await vscode.commands.executeCommand("workbench.trust.manage");
        return;
      case "newSession":
        return this.newSession();
      case "retry": {
        const failed = this.failedPrompt;
        if (!failed) return;
        if (await this.send(failed.text, failed.attachments, failed.context, failed.delivery)) {
          // The restored text is no longer needed: clear it from both the composer and storage.
          if (failed.sessionId) await this.saveDraft(failed.sessionId, "").catch(() => undefined);
          this.post({ type: "draftRestored", sessionId: failed.sessionId, text: "", force: true });
        }
        return;
      }
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
        await this.send(msg.text, msg.attachments, msg.context, msg.delivery);
        return;
      case "abort": {
        const sid = this.sessionId;
        const generation = this.execution.generation.current();
        if (this.client && sid) {
          try {
            await this.client.interrupt(sid);
          } finally {
            // A server that receives a second interrupt on an already-idle session emits no
            // terminal event. A failed request (e.g. a 500) must not leave the composer stuck on
            // "stop" either, so clear busy locally on both paths.
            this.postLocalIdle(sid, generation);
          }
        }
        return;
      }
      case "newSession":
        return this.newSession();
      case "selectSession": {
        if (!this.client) return;
        this.failedPrompt = undefined;
        const generation = this.lifecycle.generations.load.bump();
        const info = await this.client.getSession(msg.id);
        if (!this.lifecycle.generations.load.is(generation)) return;
        return this.loadSession(info, () => !this.lifecycle.generations.load.is(generation));
      }
      case "deleteSession":
        if (!this.client) return;
        await this.client.deleteSession(msg.id);
        this.sessionList.forget([msg.id]);
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
        this.sessionList.rename(msg.id, title);
        if (msg.id === this.sessionId) {
          this.post({ type: "event", event: { type: "session.renamed", data: { sessionID: msg.id, title } } });
        }
        return;
      }
      case "refreshSessions":
        return this.refreshSessions();
      case "loadMoreSessions":
        return this.loadMoreSessions();
      case "setModel": {
        const previous = this.catalog.selectedModel;
        try {
          // The server owns the session's model: commit the UI/selection only after it accepted it.
          if (this.client && this.sessionId) await this.client.switchModel(this.sessionId, msg.model);
          this.catalog.selectModel(msg.model);
        } catch (err) {
          if (previous) this.catalog.selectModel(previous);
          throw err; // `receive()` turns it into an actionable notice
        }
        return;
      }
      case "setAgent": {
        const previous = this.catalog.selectedAgent;
        try {
          if (this.client && this.sessionId) await this.client.switchAgent(this.sessionId, msg.agent);
          this.catalog.selectAgent(msg.agent);
        } catch (err) {
          if (previous) this.catalog.selectAgent(previous);
          throw err;
        }
        return;
      }
      case "setAutoApprove":
        return this.setAutoApprove(msg.enabled);
      case "saveDraft":
        return this.saveDraft(msg.sessionId, msg.text);
      case "permissionReply": {
        const sid = msg.sessionId;
        const generation = this.execution.generation.current();
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
        const generation = this.execution.generation.current();
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
          // A broken theme must not make the webview retry forever: answer with explicit misses and
          // reset so fonts registered by the previous theme are not kept around.
          this.post({ type: "fileIcons", reset: true, icons: Object.fromEntries(msg.paths.map((p) => [p, null])), fonts: {} });
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
      case "openAttachment":
        return this.openAttachment(msg.uri);
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
        return void (await this.subagents.snapshot(msg.sessionId));
      case "compact":
        return this.compact();
      case "revertTo": {
        if (!this.client || !this.sessionId || msg.sessionId !== this.sessionId) return;
        const rollback = vscode.l10n.t("Roll back");
        const messagesOnly = vscode.l10n.t("Messages only");
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t("Roll back to this turn?"),
          {
            modal: true,
            detail: vscode.l10n.t(
              "The selected prompt, its reply and every later turn will be removed from the conversation. 'Roll back' also restores file changes made after that point; 'Messages only' keeps the current files. The prompt returns to the composer so you can edit and resend it.",
            ),
          },
          rollback,
          messagesOnly,
          vscode.l10n.t("Cancel"),
        );
        if (choice !== rollback && choice !== messagesOnly) return;
        return this.revertToTurn(msg.sessionId, msg.messageID, msg.text, choice === rollback);
      }
      case "forkTo":
        return this.forkToTurn(msg.sessionId, msg.messageID);
      case "regenerate": {
        if (!this.client || !this.sessionId || msg.sessionId !== this.sessionId) return;
        const regenerate = vscode.l10n.t("Regenerate");
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t("Regenerate this response?"),
          {
            modal: true,
            detail: vscode.l10n.t(
              "The reply and every later turn will be removed and your prompt sent again. Your files stay untouched. Use Roll back if you want to restore files too.",
            ),
          },
          regenerate,
          vscode.l10n.t("Cancel"),
        );
        if (choice !== regenerate) return;
        return this.regenerateTurn(msg.sessionId, msg.messageID, msg.text, msg.attachments);
      }
      case "setInboxDelivery": {
        if (!this.client || msg.sessionId !== this.sessionId) return;
        await this.client.setInboxDelivery(msg.sessionId, msg.inboxId, msg.delivery);
        return this.refreshInbox(msg.sessionId);
      }
      case "cancelInbox": {
        if (!this.client || msg.sessionId !== this.sessionId) return;
        await this.client.cancelInbox(msg.sessionId, msg.inboxId);
        return this.refreshInbox(msg.sessionId);
      }
      case "dismissCompatibility":
        await this.ctx.globalState.update(COMPAT_DISMISSED_KEY, msg.version);
        return;
      case "dismissContract":
        await this.ctx.globalState.update(CONTRACT_DISMISSED_KEY, msg.signature);
        this.postConnection();
        return;
    }
  }

  /**
   * Put a refused prompt back in the composer and offer an exact-payload retry.
   *
   * `generation` is the token published as "running" by `send()`. The server never accepted the
   * prompt, so no terminal event will close that state: we must do it here or the status bar keeps
   * spinning forever. The guard prevents an asynchronously restored draft from overwriting a newer
   * turn that started in the meantime.
   */
  private async restoreFailedPrompt(
    text: string,
    attachments: Attachment[],
    context: ContextItem[],
    delivery: "steer" | "queue" | undefined,
    sid: string | undefined,
    detail: string,
    generation?: number,
  ): Promise<void> {
    this.failedPrompt = { text, attachments, context, delivery, sessionId: sid };
    if (sid) await this.saveDraft(sid, text).catch(() => undefined);
    this.execution.fail(sid, generation);
    this.post({ type: "draftRestored", sessionId: sid, text });
    const s = translatedStrings();
    this.post({
      type: "notice",
      error: { kind: "promptFailed", message: s["error.promptFailed"], detail, actions: ["retry", "reconnect", "showLogs"] },
    });
  }

  /** Returns false when the prompt never reached the server (no notice is posted for stale loads). */
  private async send(text: string, attachments: Attachment[], context: ContextItem[], delivery?: "steer" | "queue"): Promise<boolean> {
    // A queued message starts no turn yet: leave the current turn's reconcile generation alone.
    const turn = { generation: delivery === "queue" ? undefined : this.execution.start(this.sessionId) };
    if (delivery !== "queue") this.lifecycle.cancel("reconcile");
    if (!this.client) await this.connect();
    const client = this.client;
    if (!client || !this.folder) {
      await this.restoreFailedPrompt(
        text,
        attachments,
        context,
        delivery,
        this.sessionId,
        translatedStrings()["error.connectionLost"],
        turn.generation,
      );
      return false;
    }
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
        const loadGeneration = this.lifecycle.generations.load.bump();
        const info = await client.createSession({
          directory: this.folder.uri.fsPath,
          agent: this.catalog.selectedAgent,
          model: this.catalog.selectedModel,
          permissions,
        });
        if (autoApprove !== undefined) {
          await this.permissions.write(info.id, autoApprove);
        }
        await this.loadSession(info, () => !this.lifecycle.generations.load.is(loadGeneration), undefined, true);
        if (!this.lifecycle.generations.load.is(loadGeneration)) {
          this.execution.fail(this.sessionId, turn.generation);
          return false;
        }
        // Loading the freshly created session changes `sessionId`, which correctly closes the
        // previous session's turn. This prompt is still in flight, so re-arm it for the new id.
        if (turn.generation !== undefined && !this.execution.is(turn.generation)) {
          turn.generation = this.execution.start(this.sessionId);
        }
      }
      const sid = this.sessionId;
      if (!sid) {
        this.execution.fail(this.sessionId, turn.generation);
        return false;
      }
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
      this.failedPrompt = undefined;
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.restoreFailedPrompt(text, attachments, context, delivery, this.sessionId, detail, turn.generation);
      return false;
    }
  }

  /**
   * Open the highest-priority OpenCode config document. With no document reported by the server,
   * fall back to `opencode.json` in the workspace and create a minimal one if it is missing.
   */
  async openConfigFile(): Promise<void> {
    let client = this.client;
    if (!client) {
      await this.connect();
      client = this.client;
    }
    const folder = this.folder;
    if (!folder) return;
    const directory = folder.uri.fsPath;
    let target: string | undefined;
    if (client) {
      const entries = await client.config(directory).catch(() => [] as ConfigEntry[]);
      // The server's paths are untrusted: ignore anything that is not an OpenCode config file in
      // this workspace, and resolve symlinks before accepting the highest-priority document.
      for (const candidate of configTargetPaths(entries, directory)) {
        if (await isWithinDirectoryReal(candidate, directory)) target = candidate;
      }
    }
    // Creation is only ever performed for the in-workspace fallback, never for a server-supplied
    // path that failed validation.
    if (!target) target = path.join(directory, "opencode.json");
    if (!(await isWithinDirectoryReal(target, directory))) {
      const s = translatedStrings();
      this.post({
        type: "notice",
        error: {
          kind: "requestFailed",
          message: s["error.requestFailed"],
          detail: "Config path is outside the workspace",
          actions: ["showLogs"],
        },
      });
      return;
    }
    const uri = vscode.Uri.file(target);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from('{\n  "$schema": "https://opencode.ai/config.json"\n}\n', "utf8"));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        const s = translatedStrings();
        this.post({
          type: "notice",
          error: {
            kind: "requestFailed",
            message: s["error.requestFailed"],
            detail: err instanceof Error ? err.message : String(err),
            actions: ["showLogs"],
          },
        });
      }
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
    // even through `../` or a symlink that lexically points inside but resolves elsewhere.
    if (!isWithinDirectory(uri.fsPath, this.folder.uri.fsPath) || !(await isWithinDirectoryReal(uri.fsPath, this.folder.uri.fsPath))) {
      this.output.warn(`[chat] blocked an attempt to open a file outside the workspace: ${uri.fsPath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri.with({ query: "" }));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) this.revealLine(editor, line);
  }

  private revealLine(editor: vscode.TextEditor, line: number): void {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private async openAttachment(uri: string): Promise<void> {
    await this.attachments.open(uri);
  }

  private async openLink(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    await this.openFile(href.replace(/^\.\//, "").replace(/#L(\d+).*$/, ":$1"));
  }

  async dispose(): Promise<void> {
    this.execution.reset();
    this.sessionList.cancelSearch();
    await this.attachments.dispose();
    this.supervisor.detachServerOnly();
    this.fileIndex?.dispose();
    this.stopLivePoll();
    this.clearTimers();
    this.chatViews.dispose();
    for (const d of this.disposables) d.dispose();
  }

  // Exposed for integration tests.
  get debugState() {
    const storedSession = this.folder ? this.ctx.workspaceState.get<string>(SESSION_KEY(this.folder.uri.toString())) : undefined;
    return {
      status: this.status,
      sessionId: this.sessionId,
      storedSession,
      folder: this.folder?.uri.fsPath,
      baseUrl: this.client?.conn.baseUrl,
      livePolling: this.lifecycle.hasInterval("livePoll"),
    };
  }
}
