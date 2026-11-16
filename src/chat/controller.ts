import * as vscode from "vscode";
import { ApiError, OpenCodeClient, type PermissionRule } from "../client/http";
import { EventStream } from "../client/sse";
import { ExternalServer, ManagedServer, ServerError, type ServerHandle, type ServerState } from "../server/server";
import type { AgentInfo, FileAttachment, ModelInfo, ModelRef, ServerEvent, SessionInfo } from "../shared/api";
import { eventSessionId } from "../shared/chatReducer";
import type {
  ActionId,
  Attachment,
  ConnectionStatus,
  ContextItem,
  HostMessage,
  SessionSummary,
  UiError,
  UiErrorKind,
  WebviewMessage,
} from "../shared/protocol";
import { STRINGS, type StringKey, type Strings } from "../shared/strings";
import { ContextTracker, FileIndex, selectionAttachment } from "./context";
import { DiffService } from "./diff";
import { DEFAULT_SESSION_PERMISSIONS } from "./permissions";

const PASSWORD_KEY = (endpoint: string) => `opencode.password:${endpoint}`;
const SESSION_KEY = (folder: string) => `opencode.session:${folder}`;
const MODEL_KEY = "opencode.lastModel";
const AGENT_KEY = "opencode.lastAgent";

export function translatedStrings(): Strings {
  const out = {} as Strings;
  for (const [k, v] of Object.entries(STRINGS)) out[k as StringKey] = vscode.l10n.t(v);
  return out;
}

/** One server per workspace folder, created lazily. */
export class ServerRegistry implements vscode.Disposable {
  private readonly servers = new Map<string, ServerHandle>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (line: string) => void,
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
  private models: ModelInfo[] = [];
  private agents: AgentInfo[] = [];
  private selectedModel: ModelRef | undefined;
  private selectedAgent: string | undefined;
  private fileIndex: FileIndex | undefined;
  private readonly context: ContextTracker;
  private readonly disposables: vscode.Disposable[] = [];
  private sessionsTimer: NodeJS.Timeout | undefined;
  private changesTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;
  private wasDisconnected = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly registry: ServerRegistry,
    private readonly diffs: DiffService,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.context = new ContextTracker((items) => this.post({ type: "context", items }));
    this.disposables.push(
      this.context,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.postInit();
        if (this.folder && !vscode.workspace.workspaceFolders?.some((f) => f.uri.toString() === this.folder?.uri.toString())) {
          void this.switchFolder(this.pickFolder());
        }
      }),
    );
  }

  // ---- view wiring ------------------------------------------------------------------------

  attachView(view: vscode.WebviewView): void {
    this.view = view;
    const sub = view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.receive(msg));
    view.onDidDispose(() => {
      sub.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  /** Entry point for webview messages (also used by integration tests). */
  async receive(msg: WebviewMessage): Promise<void> {
    try {
      await this.handle(msg);
    } catch (err) {
      this.output.error(`[chat] ${msg.type} failed: ${String(err)}`);
      this.post({ type: "notice", error: toUiError(err) });
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
    });
  }

  private setStatus(status: ConnectionStatus, error?: UiError): void {
    this.status = status;
    this.lastError = error;
    this.post({ type: "connection", status, error, version: this.version });
  }

  // ---- connection -------------------------------------------------------------------------

  /** Starts (or reuses) the server for the current folder and loads everything. */
  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => (this.connecting = undefined));
    }
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
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
      await this.useConnection(conn, server.state.status === "running" ? server.state.version : undefined);
    } catch (err) {
      this.output.error(`[chat] connect failed: ${String(err)}`);
      this.setStatus("error", toUiError(err, "startFailed"));
    }
  }

  private async useConnection(conn: { baseUrl: string; password?: string }, version?: string): Promise<void> {
    if (this.client?.conn.baseUrl === conn.baseUrl && this.client.conn.password === conn.password && this.stream) {
      return;
    }
    this.stream?.close();
    this.client = new OpenCodeClient(conn);
    this.version = version;
    this.fileIndex?.dispose();
    this.fileIndex = this.folder ? new FileIndex(this.folder) : undefined;
    this.stream = new EventStream({
      url: this.client.eventUrl(),
      headers: this.client.headers(),
      onEvent: (e) => this.onEvent(e),
      onStatus: (status, error) => this.onStreamStatus(status, error),
    });
    this.stream.start();
    await this.loadAll();
  }

  private async loadAll(): Promise<void> {
    const client = this.client;
    if (!client || !this.folder) return;
    const [models, defaultModel, agents] = await Promise.all([
      client.models().catch(() => [] as ModelInfo[]),
      client.defaultModel().catch(() => null),
      client.agents().catch(() => [] as AgentInfo[]),
    ]);
    this.models = models.filter((m) => m.enabled !== false);
    this.agents = agents.filter((a) => a.mode !== "subagent" && !a.hidden);
    const saved = this.ctx.globalState.get<ModelRef>(MODEL_KEY);
    const exists = (ref?: ModelRef) => !!ref && this.models.some((m) => m.id === ref.id && m.providerID === ref.providerID);
    const fallback = defaultModel ?? this.models[0];
    this.selectedModel = exists(saved) ? saved : fallback ? { id: fallback.id, providerID: fallback.providerID } : undefined;
    const savedAgent = this.ctx.globalState.get<string>(AGENT_KEY);
    this.selectedAgent = this.agents.some((a) => a.id === savedAgent)
      ? savedAgent
      : (this.agents.find((a) => a.id === "build") ?? this.agents[0])?.id;

    const sessionId = this.sessionId ?? this.ctx.workspaceState.get<string>(SESSION_KEY(this.folder.uri.toString()));
    let session: SessionInfo | undefined;
    if (sessionId) {
      session = await client.getSession(sessionId).catch(() => undefined);
    }
    await this.refreshSessions();
    if (session) {
      await this.loadSession(session);
    } else {
      this.sessionId = undefined;
      this.postCatalog();
      this.post({ type: "session", session: null });
    }
    if (this.models.length === 0) {
      const s = translatedStrings();
      this.setStatus("error", { kind: "noProvider", message: s["error.noProvider"], actions: ["login", "reconnect", "showLogs"] });
    } else {
      this.setStatus("connected");
    }
    this.post({ type: "context", items: this.context.current() });
  }

  private postCatalog(): void {
    this.post({
      type: "catalog",
      models: this.models,
      agents: this.agents,
      selectedModel: this.selectedModel,
      selectedAgent: this.selectedAgent,
    });
  }

  private onServerState(state: ServerState): void {
    if (state.status === "starting" && this.status === "connected") {
      this.setStatus("reconnecting");
    } else if (state.status === "running" && this.client?.conn.baseUrl !== state.conn.baseUrl) {
      // The managed process was restarted on a new port.
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

  /** Live stream has no replay: re-fetch the current session after a reconnect. */
  private async resync(): Promise<void> {
    try {
      await this.refreshSessions();
      if (this.sessionId && this.client) {
        const info = await this.client.getSession(this.sessionId);
        await this.loadSession(info);
      }
      if (this.status !== "error" || this.lastError?.kind === "connectionLost") this.setStatus("connected");
    } catch (err) {
      this.output.error(`[chat] resync failed: ${String(err)}`);
    }
  }

  // ---- events -----------------------------------------------------------------------------

  private onEvent(event: ServerEvent): void {
    const sid = eventSessionId(event);
    if (sid && sid === this.sessionId) this.post({ type: "event", event });
    switch (event.type) {
      case "session.created":
      case "session.renamed":
      case "session.deleted":
      case "session.execution.started":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.scheduleSessions();
        break;
      default:
        break;
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

  private scheduleSessions(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => void this.refreshSessions().catch(() => {}), 250);
  }

  private scheduleChanges(): void {
    if (this.changesTimer) clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.refreshChanges().catch(() => {}), 400);
  }

  async refreshSessions(): Promise<void> {
    if (!this.client || !this.folder) return;
    const list = await this.client.listSessions(this.folder.uri.fsPath);
    const items: SessionSummary[] = list
      .filter((s) => !s.parentID && !s.time.archived)
      .map((s) => ({
        id: s.id,
        title: s.title ?? "",
        updated: s.time.updated,
        busy: (s.time.busy ?? 0) > (s.time.idle ?? 0),
      }));
    this.post({ type: "sessions", items, currentId: this.sessionId });
  }

  async refreshChanges(): Promise<void> {
    if (!this.client || !this.sessionId) {
      this.post({ type: "changedFiles", files: [] });
      return;
    }
    const files = await this.client.diff(this.sessionId).catch(() => []);
    this.post({ type: "changedFiles", files });
  }

  private async loadSession(info: SessionInfo): Promise<void> {
    if (!this.client || !this.folder) return;
    const [messages, permissions, forms] = await Promise.all([
      this.client.messages(info.id),
      this.client.permissions(info.id).catch(() => []),
      this.client.forms(info.id).catch(() => []),
    ]);
    this.sessionId = info.id;
    await this.ctx.workspaceState.update(SESSION_KEY(this.folder.uri.toString()), info.id);
    if (info.model && this.models.some((m) => m.id === info.model?.id && m.providerID === info.model?.providerID)) {
      this.selectedModel = info.model;
    }
    if (info.agent && this.agents.some((a) => a.id === info.agent)) this.selectedAgent = info.agent;
    this.postCatalog();
    this.post({
      type: "session",
      session: {
        id: info.id,
        title: info.title,
        agent: info.agent,
        model: info.model,
        busy: (info.time.busy ?? 0) > (info.time.idle ?? 0),
        messages,
        permissions,
        forms,
      },
    });
    await this.refreshSessions();
    await this.refreshChanges();
  }

  // ---- commands ---------------------------------------------------------------------------

  async newSession(): Promise<void> {
    this.sessionId = undefined;
    if (this.folder) await this.ctx.workspaceState.update(SESSION_KEY(this.folder.uri.toString()), undefined);
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.postCatalog();
    await this.refreshSessions().catch(() => {});
    this.post({ type: "focusInput" });
  }

  async reconnect(): Promise<void> {
    if (!this.server) return this.connect();
    this.setStatus("starting");
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
    try {
      const conn = await this.server.restart();
      await this.useConnection(conn, this.server.state.status === "running" ? this.server.state.version : undefined);
    } catch (err) {
      this.setStatus("error", toUiError(err, "startFailed"));
    }
  }

  async resetServers(): Promise<void> {
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
    this.serverSub?.();
    this.serverSub = undefined;
    this.server = undefined;
    await this.registry.reset();
    if (this.view) await this.connect();
  }

  async switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (folder?.uri.toString() === this.folder?.uri.toString()) return;
    this.stream?.close();
    this.stream = undefined;
    this.client = undefined;
    this.sessionId = undefined;
    this.folder = folder;
    this.postInit();
    this.post({ type: "session", session: null });
    await this.connect();
  }

  addAttachment(item: Attachment): void {
    this.post({ type: "addAttachment", item });
  }

  addSelection(editor: vscode.TextEditor | undefined): boolean {
    if (!editor) return false;
    const att = selectionAttachment(editor);
    if (!att) return false;
    this.addAttachment(att);
    return true;
  }

  async setPassword(): Promise<void> {
    const endpoint = vscode.workspace.getConfiguration("opencode").get<string>("endpoint", "").trim();
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
        const exe = vscode.workspace.getConfiguration("opencode").get<string>("executablePath", "opencode") || "opencode";
        const terminal = vscode.window.createTerminal({ name: "OpenCode auth", cwd: this.folder?.uri });
        terminal.show();
        terminal.sendText(`${/\s/.test(exe) ? `"${exe}"` : exe} auth login`);
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
        this.post({ type: "connection", status: this.status, error: this.lastError, version: this.version });
        if (this.client && this.status !== "error") {
          await this.loadAll();
        } else {
          await this.connect();
        }
        return;
      case "send":
        return this.send(msg.text, msg.attachments, msg.context);
      case "abort":
        if (this.client && this.sessionId) await this.client.interrupt(this.sessionId);
        return;
      case "newSession":
        return this.newSession();
      case "selectSession": {
        if (!this.client) return;
        const info = await this.client.getSession(msg.id);
        return this.loadSession(info);
      }
      case "deleteSession":
        if (!this.client) return;
        await this.client.deleteSession(msg.id);
        if (msg.id === this.sessionId) await this.newSession();
        else await this.refreshSessions();
        return;
      case "refreshSessions":
        return this.refreshSessions();
      case "setModel":
        this.selectedModel = msg.model;
        await this.ctx.globalState.update(MODEL_KEY, msg.model);
        if (this.client && this.sessionId) await this.client.switchModel(this.sessionId, msg.model);
        this.postCatalog();
        return;
      case "setAgent":
        this.selectedAgent = msg.agent;
        await this.ctx.globalState.update(AGENT_KEY, msg.agent);
        if (this.client && this.sessionId) await this.client.switchAgent(this.sessionId, msg.agent);
        this.postCatalog();
        return;
      case "permissionReply":
        await this.client?.replyPermission(msg.sessionId, msg.requestId, msg.decision);
        return;
      case "formReply":
        await this.client?.replyForm(msg.sessionId, msg.formId, msg.answer);
        return;
      case "formCancel":
        await this.client?.cancelForm(msg.sessionId, msg.formId);
        return;
      case "searchFiles": {
        const items = (await this.fileIndex?.search(msg.query)) ?? [];
        this.post({ type: "fileResults", query: msg.query, items });
        return;
      }
      case "openDiff":
        if (this.folder) await this.diffs.open(this.folder.uri, msg.file, msg.patch, msg.applied);
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
        return this.refreshChanges();
    }
  }

  private async send(text: string, attachments: Attachment[], context: ContextItem[]): Promise<void> {
    if (!this.client) await this.connect();
    const client = this.client;
    if (!client || !this.folder) throw new Error(translatedStrings()["error.connectionLost"]);
    const files: FileAttachment[] = [];
    const seen = new Set<string>();
    for (const item of [...context, ...attachments]) {
      if (seen.has(item.uri)) continue;
      seen.add(item.uri);
      files.push({ uri: item.uri, name: "name" in item ? item.name : item.label });
    }
    try {
      if (!this.sessionId) {
        const permissions = vscode.workspace
          .getConfiguration("opencode", this.folder.uri)
          .get<PermissionRule[]>("sessionPermissions", DEFAULT_SESSION_PERMISSIONS);
        const info = await client.createSession({
          directory: this.folder.uri.fsPath,
          agent: this.selectedAgent,
          model: this.selectedModel,
          permissions,
        });
        await this.loadSession(info);
      }
      await client.prompt(this.sessionId!, text, files);
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
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    if (this.changesTimer) clearTimeout(this.changesTimer);
    for (const d of this.disposables) d.dispose();
  }

  // Exposed for integration tests.
  get debugState() {
    const storedSession = this.folder ? this.ctx.workspaceState.get<string>(SESSION_KEY(this.folder.uri.toString())) : undefined;
    return { status: this.status, sessionId: this.sessionId, storedSession, folder: this.folder?.uri.fsPath, baseUrl: this.client?.conn.baseUrl };
  }
}
