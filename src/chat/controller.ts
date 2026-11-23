import * as path from "node:path";
import * as vscode from "vscode";
import { OpenCodeClient, type Connection } from "../client/http";
import { CatalogService } from "./catalogService";
import { ConnectionSupervisor } from "./connectionSupervisor";
import { FileIconThemeService, type LanguageContribution } from "./fileIconTheme";
import { ChatLifecycle } from "./lifecycle";
import { Generation } from "./generation";
import { describeServerError, ServerError, type ServerHandle, type ServerState } from "../server/server";
import type { ServerEvent } from "../shared/api";

import { checkCompatibility } from "../shared/compatibility";

import { checkContract, contractSignature, type ContractObservations } from "../shared/contract";
import { isWebviewMessage } from "../shared/protocolGuards";
import type { ActionId, Attachment, ConnectionStatus, HostMessage, SessionSummary, UiError, WebviewMessage } from "../shared/protocol";

import { AttachmentService } from "./attachmentService";
import { SessionListService, type SessionSearchResult } from "./sessionListService";
import { SubagentTracker } from "./subagentTracker";
import { ContextTracker, FileIndex } from "./context";
import { PromptLibraryService } from "./promptLibrary";
import { formatPromptDiff, formatPromptDiagnostics } from "./promptContext";
import { ApplyCodeService } from "./applyCode";
import { DEFAULT_INSTRUCTION_FILE, ProjectInstructionService } from "./projectInstructions";
import { workingDiff } from "./gitDiff";
import { ChatViews, type ChatWebview } from "./views";
import { DiffService } from "./diff";

import { PermissionService } from "./permissionService";

import { isWithinDirectory } from "./tempAttachments";
import { isWithinDirectoryReal } from "./pathSafety";

import { BoundedSet } from "../shared/boundedSet";
import { ChatEventRouter } from "./eventRouter";
import { ChatCommandHandler } from "./commandHandler";
import { ExecutionStateService, type ExecutionState } from "./executionState";
import { createControllerState } from "./controllerState";
import { ChatDraftActions } from "./draftActions";
import { ChatFileActions } from "./fileActions";
import { ChatServerActions } from "./serverActions";
import { ChatPromptActions } from "./promptActions";
import { ChatSessionService } from "./sessionService";
import { ChatPermissionActions } from "./permissionActions";
import { ChatRefreshActions } from "./refreshActions";

export type { ExecutionState, ExecutionStatus, TerminalStatus } from "./executionState";

import { SESSION_KEY, COMPAT_DISMISSED_KEY, CONTRACT_DISMISSED_KEY, DRAFTS_KEY } from "./storageKeys";

import { MAX_DELETE_IDS, MAX_DELETE_PAGES, ServerRegistry, toUiError, translatedStrings } from "./controllerSupport";

export { ServerRegistry, translatedStrings } from "./controllerSupport";

export type { SessionSearchResult } from "./sessionListService";

export class ChatController implements vscode.Disposable {
  private readonly state = createControllerState();
  private readonly permissionActions: ChatPermissionActions;
  private readonly fileActions: ChatFileActions;
  private readonly refreshActions: ChatRefreshActions;
  private readonly draftActions: ChatDraftActions;
  private readonly serverActions: ChatServerActions;
  private readonly sessionService: ChatSessionService;
  private readonly promptActions: ChatPromptActions;
  /** All live chats and their listeners; see views.ts. */
  private readonly chatViews: ChatViews;
  /** Server process, HTTP client and SSE stream ownership; see connectionSupervisor.ts. */
  private readonly supervisor: ConnectionSupervisor;
  /** Server-provided catalog and the user's model/agent selection. */
  private readonly catalog: CatalogService;
  /** File icons come from the user's active icon theme, resolved on demand for the webview. */
  private readonly fileIcons: FileIconThemeService;
  private fileIndex: FileIndex | undefined;
  private readonly context: ContextTracker;
  /** Applies a reply's code block as a reviewable, accepted-only WorkspaceEdit. */
  private readonly applyCode: ApplyCodeService<vscode.Uri>;
  /** Built-in + user prompts inserted into the composer with editor context resolved. */
  private readonly prompts: PromptLibraryService;
  private readonly projectInstructions: ProjectInstructionService<vscode.Uri>;
  private readonly disposables: vscode.Disposable[] = [];
  /** Inline permissions: per-chat auto-approve, granted ids and pending-request filtering. */
  private readonly permissions: PermissionService;
  /** All in-flight tokens and timers live in one place; see lifecycle.ts. */
  private readonly lifecycle = new ChatLifecycle();
  private readonly eventRouter: ChatEventRouter;
  private readonly commandHandler: ChatCommandHandler;
  /** Single owner of turn status, generation and local-idle grace; see executionState.ts. */
  private readonly execution = new ExecutionStateService();
  /** Picker paging, summaries, fork visibility and bounded search; see sessionListService.ts. */
  private readonly sessionList: SessionListService;
  /** Child discovery, event routing and snapshots; see subagentTracker.ts. */
  private readonly subagents: SubagentTracker;

  /** Drops, picker, inline staging and the attachment path allowlist; see attachmentService.ts. */
  private readonly attachments: AttachmentService;
  /** Attention requests already announced while the chat was hidden (avoids notification spam). */
  private readonly announcedHiddenAttention = new BoundedSet<string>(500);

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
        if (this.state.status === "connected" && this.client) void this.sessionService.resync();
      },
    );
    this.supervisor = new ConnectionSupervisor({
      registry,
      log: (line) => output.info(line),
      getFolder: () => this.state.folder,
      setFolder: (folder) => {
        this.state.folder = folder;
      },
      pickFolder: () => this.pickFolder() as vscode.WorkspaceFolder,
      trustBlocked: () => this.trustBlocked(),
      postUntrusted: () => this.postUntrusted(),
      setStatus: (status, error) => this.setStatus(status, error),
      getStatus: () => this.state.status,
      generation: this.lifecycle.generations.connect,
      onReady: (conn, version, stale) => {
        this.state.version = version;
        return this.useConnection(conn, stale);
      },
      onStreamReconnect: () => {
        void this.sessionService.resync();
      },
      onDetached: () => {
        this.state.lastKnownMessage = undefined;
        this.sessionService.stopLivePoll();
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
      (item) => this.fileActions.addAttachment(item),
      (kind, name, detail) =>
        kind === "tooLarge" ? this.fileActions.noticeTooLarge(name) : this.fileActions.noticeUnreadable(name, detail),
      (line) => output.warn(line),
      (editor, line) => this.fileActions.revealLine(editor, line),
    );
    this.subagents = new SubagentTracker(
      () => this.client,
      () => this.state.sessionId,
      () => this.state.folder?.uri.fsPath,
      this.lifecycle.generations.child,
      (msg) => this.post(msg),
      (line) => output.warn(line),
      (client, childId, requests, autoApprove) => this.permissions.filterPending(client, childId, requests, autoApprove),
      () => this.permissionActions.enabled(),
    );
    this.sessionList = new SessionListService(
      () => this.client,
      () => this.state.folder?.uri.fsPath,
      () => this.state.sessionId,
      this.lifecycle.generations.sessions,
      (msg) => this.post(msg),
      (line) => output.warn(line),
      () => {
        const configured = vscode.workspace.getConfiguration("opencode", this.state.folder?.uri).get<number>("sessionPageSize", 10);
        return Math.min(100, Math.max(1, Math.floor(configured) || 10));
      },
      () => (this.state.folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? this.state.folder.name : undefined),
    );
    this.context = new ContextTracker((items) => this.post({ type: "context", items }));

    this.applyCode = new ApplyCodeService<vscode.Uri>({
      t: (message, ...args) => vscode.l10n.t(message, ...args),
      folder: () => this.state.folder?.uri.fsPath,
      activePath: () => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined;
      },
      resolve: (targetPath) => this.resolveWorkspacePath(targetPath),
      pickPath: async (candidates) => {
        const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 200);
        const items = [...new Set([...candidates, ...files.map((uri) => vscode.workspace.asRelativePath(uri, false))])];
        return vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("Choose a file to apply this code to") });
      },
      read: async (uri) => {
        try {
          return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          return undefined;
        }
      },
      preview: (uri, current, proposed) => this.diffs.openProposal(uri, current, proposed),
      confirm: async () => {
        const accept = vscode.l10n.t("Accept");
        const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Apply this change?"), accept, vscode.l10n.t("Reject"));
        return choice === accept;
      },
      write: async (uri, content) => {
        let document: vscode.TextDocument | undefined;
        try {
          document = await vscode.workspace.openTextDocument(uri);
        } catch {
          document = undefined;
        }
        const edit = new vscode.WorkspaceEdit();
        if (document) {
          edit.set(uri, [new vscode.TextEdit(new vscode.Range(0, 0, document.lineCount, 0), content)]);
        } else {
          edit.createFile(uri);
          edit.insert(uri, new vscode.Position(0, 0), content);
        }
        await vscode.workspace.applyEdit(edit);
      },
      warn: (message) => this.output.warn(message),
      info: (message) => void vscode.window.showInformationMessage(message),
    });
    this.prompts = new PromptLibraryService({
      t: (text) => vscode.l10n.t(text),
      userPrompts: () =>
        vscode.workspace
          .getConfiguration("opencode", this.state.folder?.uri)
          .get<Array<{ id?: unknown; title?: unknown; description?: unknown; text?: unknown }>>("promptLibrary", []),
      selection: () => {
        const editor = vscode.window.activeTextEditor;
        return editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
      },
      filePath: () => {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.uri.scheme === "file" ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
      },
      diff: async () => {
        const cwd = this.state.folder?.uri.fsPath;
        if (!cwd) return "";
        const diff = await workingDiff(cwd);
        return diff ? formatPromptDiff(diff) : "";
      },
      problems: async () => {
        const file = vscode.window.activeTextEditor?.document.uri.toString();
        const items = vscode.languages
          .getDiagnostics()
          .flatMap(([uri, list]) =>
            file && uri.toString() !== file
              ? []
              : list.map((d) => ({ uri: uri.path, startLine: d.range.start.line, message: d.message, severity: d.severity })),
          );
        return formatPromptDiagnostics(items);
      },
    });
    this.projectInstructions = new ProjectInstructionService<vscode.Uri>({
      t: (message, ...args) => vscode.l10n.t(message, ...args),
      folder: () => this.state.folder?.uri.fsPath,
      pickTarget: async () => {
        const custom = vscode.l10n.t("Choose another file…");
        const choice = await vscode.window.showQuickPick([DEFAULT_INSTRUCTION_FILE, custom], {
          placeHolder: vscode.l10n.t("Where should this instruction be saved?"),
        });
        if (!choice) return undefined;
        if (choice !== custom) return choice;
        return vscode.window.showInputBox({
          prompt: vscode.l10n.t("Markdown file inside the workspace"),
          value: DEFAULT_INSTRUCTION_FILE,
          validateInput: (value) => {
            if (!value.trim() || !value.endsWith(".md") || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
              return vscode.l10n.t("Enter a relative .md path inside the workspace.");
            }
            return undefined;
          },
        });
      },
      resolveTarget: (targetPath) => this.resolveWorkspacePath(targetPath),
      read: async (uri) => {
        try {
          return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          return undefined;
        }
      },
      write: async (uri, content) => {
        const edit = new vscode.WorkspaceEdit();
        let document: vscode.TextDocument | undefined;
        try {
          document = await vscode.workspace.openTextDocument(uri);
        } catch {
          document = undefined;
        }
        if (document) {
          edit.set(uri, [new vscode.TextEdit(new vscode.Range(0, 0, document.lineCount, 0), content)]);
        } else {
          edit.createFile(uri);
          edit.insert(uri, new vscode.Position(0, 0), content);
        }
        await vscode.workspace.applyEdit(edit);
      },
      now: () => new Date(),
      warn: (message) => this.output.warn(message),
      info: (message) => void vscode.window.showInformationMessage(message),
    });
    this.permissions = new PermissionService(
      ctx,
      () => this.state.folder,
      (line) => output.info(line),
    );
    this.catalog = new CatalogService(
      ctx,
      (msg) => this.post(msg),
      (line) => output.info(line),
      () => this.chatViews.size > 0,
    );
    this.eventRouter = new ChatEventRouter({
      getSessionId: () => this.state.sessionId,
      getFolderUri: () => this.state.folder?.uri,
      isVisible: () => this.isVisible,
      noteSessionEvent: () => {
        this.state.lastSessionEventAt = Date.now();
      },
      post: (msg) => this.post(msg),
      postSessionEvent: (sid, event) => this.postSessionEvent(sid, event),
      subagents: this.subagents,
      permissions: this.permissions,
      execution: this.execution,
      attention: this.announcedHiddenAttention,
      scheduleInbox: () => this.refreshActions.scheduleInbox(),
      scheduleSessions: () => this.refreshActions.scheduleSessions(),
      scheduleReconcile: () => this.sessionService.scheduleReconcile(),
      scheduleChanges: () => this.refreshActions.scheduleChanges(),
      refreshSlashItems: async () => {
        await this.sessionService.refreshSlashItems();
      },
      autoApprove: (event, sid) => this.permissionActions.autoApprove(event, sid),
      newSession: () => this.newSession(),
    });
    this.fileIcons = new FileIconThemeService({
      themeId: () => vscode.workspace.getConfiguration("workbench").get<string | null>("iconTheme") ?? undefined,
      variant: () => {
        const kind = vscode.window.activeColorTheme.kind;
        if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) return "highContrast";
        return kind === vscode.ColorThemeKind.Light ? "light" : "dark";
      },
      associations: () =>
        vscode.workspace.getConfiguration("files", this.state.folder?.uri).get<Record<string, string>>("associations", {}),
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
    this.commandHandler = new ChatCommandHandler({
      getClient: () => this.client,
      getSessionId: () => this.state.sessionId,
      getFolder: () => this.state.folder,
      getStatus: () => this.state.status,
      clearFailedPrompt: () => {
        this.state.failedPrompt = undefined;
      },
      post: (msg) => this.post(msg),
      postInit: () => this.postInit(),
      postConnection: () => this.postConnection(),
      postDrafts: () => this.draftActions.post(),
      postLocalIdle: (sid, generation) => this.postLocalIdle(sid, generation),
      connect: () => this.connect(),
      loadAll: () => this.sessionService.loadAll(),
      loadSession: (info, stale) => this.sessionService.loadSession(info, stale),
      send: (text, attachments, context, delivery) => this.promptActions.send(text, attachments, context, delivery),
      newSession: () => this.newSession(),
      saveDraft: (sid, text) => this.draftActions.save(sid, text),
      refreshSessions: () => this.refreshSessions(),
      loadMoreSessions: () => this.loadMoreSessions(),
      setAutoApprove: (enabled) => this.permissionActions.set(enabled),
      setPassword: () => this.serverActions.setPassword(),
      dropFiles: (files) => this.fileActions.dropFiles(files),
      pickFiles: () => this.fileActions.pickFiles(),
      openFile: (file) => this.fileActions.openFile(file),
      openAttachment: (uri) => this.fileActions.openAttachment(uri),
      openLink: (href) => this.fileActions.openLink(href),
      runAction: (id) => this.serverActions.run(id),
      switchFolder: (folder) => this.switchFolder(folder),
      refreshChanges: () => this.refreshActions.refreshChanges(),
      syncNow: () => this.sessionService.syncNow(),
      compact: () => this.promptActions.compact(),
      revertToTurn: (sessionId, messageID, text, files) => this.promptActions.revertToTurn(sessionId, messageID, text, files),
      forkToTurn: (sessionId, messageID) => this.promptActions.forkToTurn(sessionId, messageID),
      regenerateTurn: (sessionId, messageID, text, attachments) =>
        this.promptActions.regenerateTurn(sessionId, messageID, text, attachments),
      refreshInbox: (sid) => this.refreshActions.refreshInbox(sid),
      deleteAllSessions: () => this.deleteAllSessions(),
      catalog: this.catalog,
      sessionList: this.sessionList,
      permissions: this.permissions,
      subagents: this.subagents,
      execution: this.execution,
      generation: this.lifecycle.generations.load,
      getFileIndex: () => this.fileIndex,
      applyCode: (text, targetPath) => this.applyCode.apply(text, targetPath),
      usePrompt: (id) => this.promptActions.usePrompt(id),
      saveInstruction: (text) => this.promptActions.saveInstruction(text),
      fileIcons: this.fileIcons,
      diffs: this.diffs,
      workspaceState: ctx.workspaceState,
      globalState: ctx.globalState,
      t: (message, ...args) => vscode.l10n.t(message, ...args),
      confirmDanger: (opts) =>
        Promise.resolve(vscode.window.showWarningMessage(opts.title, { modal: true, detail: opts.detail }, ...opts.choices)),
      copyToClipboard: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
      getWorkspaces: () => vscode.workspace.workspaceFolders ?? [],
      log: (line) => output.warn(line),
    });
    this.permissionActions = new ChatPermissionActions({
      state: this.state,
      permissions: this.permissions,
      subagents: this.subagents,
      getClient: () => this.client,
      post: (msg) => this.post(msg),
      postSessionEvent: (sid, event) => this.postSessionEvent(sid, event),
      log: (line) => output.info(line),
    });
    this.fileActions = new ChatFileActions({
      state: this.state,
      attachments: this.attachments,
      post: (msg) => this.post(msg),
      logWarn: (line) => output.warn(line),
      isWithinWorkspace: (file) => this.isWithinWorkspace(file),
    });
    this.refreshActions = new ChatRefreshActions({
      state: this.state,
      lifecycle: this.lifecycle,
      getClient: () => this.client,
      post: (msg) => this.post(msg),
      refreshSessions: () => this.refreshSessions(),
    });
    this.draftActions = new ChatDraftActions({
      state: this.state,
      workspaceState: ctx.workspaceState,
      post: (msg) => this.post(msg),
    });
    this.serverActions = new ChatServerActions({
      state: this.state,
      secrets: ctx.secrets,
      output,
      reconnect: () => this.reconnect(),
      resetServers: () => this.resetServers(),
      newSession: () => this.newSession(),
      send: (text, attachments, context, delivery) => this.promptActions.send(text, attachments, context, delivery),
      saveDraft: (sid, text) => this.draftActions.save(sid, text),
      post: (msg) => this.post(msg),
    });
    this.sessionService = new ChatSessionService({
      state: this.state,
      ctx,
      output,
      lifecycle: this.lifecycle,
      execution: this.execution,
      catalog: this.catalog,
      context: this.context,
      subagents: this.subagents,
      permissions: this.permissions,
      attention: this.announcedHiddenAttention,
      permissionActions: this.permissionActions,
      refreshActions: this.refreshActions,
      getClient: () => this.client,
      isVisible: () => this.isVisible,
      abortConnectionRequests: () => this.abortConnectionRequests(),
      clearTimers: () => this.clearTimers(),
      post: (msg) => this.post(msg),
      setStatus: (status, error) => this.setStatus(status, error),
      observeContract: (observations) => this.observeContract(observations),
      bestEffort: (label, promise, fallback) => this.bestEffort(label, promise, fallback),
      refreshSessions: () => this.refreshSessions(),
    });
    this.promptActions = new ChatPromptActions({
      state: this.state,
      execution: this.execution,
      lifecycle: this.lifecycle,
      catalog: this.catalog,
      permissions: this.permissions,
      sessionList: this.sessionList,
      prompts: this.prompts,
      projectInstructions: this.projectInstructions,
      fileActions: this.fileActions,
      draftActions: this.draftActions,
      sessionService: this.sessionService,
      output,
      getClient: () => this.client,
      getServer: () => this.server,
      connect: () => this.connect(),
      prefillDraft: (text, attachments) => this.prefillDraft(text, attachments),
      post: (msg) => this.post(msg),
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
        // Rebuild the file index so added folders become searchable and removed ones disappear.
        this.fileIndex?.dispose();
        const folders = vscode.workspace.workspaceFolders ?? [];
        this.fileIndex = folders.length > 0 ? new FileIndex(folders, this.ctx.workspaceState) : undefined;
        if (this.state.folder && !folders.some((f) => f.uri.toString() === this.state.folder?.uri.toString())) {
          void this.switchFolder(this.pickFolder());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("opencode.autoApprovePermissions")) {
          this.permissionActions.post();
          if (this.permissions.enabled(this.state.sessionId)) void this.permissionActions.approvePending();
        }
        if (e.affectsConfiguration("opencode.dropzone")) {
          this.post({ type: "dropzone", enabled: this.dropzoneEnabled() });
        }
        if (e.affectsConfiguration("opencode.toolOutputLimit")) this.postInit();
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

  /** Recently updated sessions for Ctrl/Cmd+Alt+S, without a second "search all" dialog. */
  recentSessions(): SessionSummary[] {
    return this.sessionList.recent();
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
    if (result.sessionId !== this.state.sessionId) await this.receive({ type: "selectSession", id: result.sessionId });
    if (result.messageId) this.post({ type: "revealMessage", messageId: result.messageId, sessionId: result.sessionId });
  }

  /** Fills the composer from an editor context action, attaching the selection it came from. */
  prefillDraft(text: string, attachments: Attachment[]): void {
    this.post({ type: "prefillDraft", sessionId: this.state.sessionId ?? undefined, text, attachments });
  }

  /** Serializes webview messages: a late `ready`/loadAll must not race a prompt and drop its events. */
  private messageQueue: Promise<unknown> = Promise.resolve();

  /** Dedicated token: ordinary session refreshes must not cancel a bulk delete. */
  private readonly deleteGeneration = new Generation();

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

  /** Workspace folder this chat is connected to, for host commands that need a cwd (git, terminal). */
  get folderUri(): vscode.Uri | undefined {
    return this.state.folder?.uri;
  }

  /** Session shown in the chat, for commands that hand the conversation to another client. */
  get currentSessionId(): string | undefined {
    return this.state.sessionId;
  }

  post(msg: HostMessage): void {
    this.chatViews.post(msg);
  }

  private abortConnectionRequests(): void {
    this.state.connectionAbort?.abort();
    this.state.connectionAbort = undefined;
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
    if (sid !== this.state.sessionId || !this.execution.markLocalIdle(sid, generation)) return;
    this.post({
      type: "event",
      // `local` tells the webview to also finish the partial assistant message and its turn: the
      // server emits no terminal event in these cases, so nothing else would close the streaming
      // card (shimmer + disabled copy button forever).
      // A synthetic event still has the same structural shape as a real one (type + data).
      event: { type: "session.status", data: { sessionID: sid, status: { type: "idle", local: true } } },
    });
    // The server may emit no terminal event for a local idle, and `onEvent` is the only other
    // place that refreshes the list and replaces the partial message with server history.
    this.refreshActions.scheduleSessions();
    this.sessionService.scheduleReconcile();
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
      activeFolder: this.state.folder?.uri.toString(),
      issuesUrl: (this.ctx.extension.packageJSON as { bugs?: { url?: string } }).bugs?.url,
      dropzone: this.dropzoneEnabled(),
      toolOutputLimit: vscode.workspace.getConfiguration("opencode", this.state.folder?.uri).get<number>("toolOutputLimit", 4000),
    });
    this.post({ type: "promptCatalog", items: this.prompts.catalog() });
  }

  /** True when a file really lives in any folder the user opened, after resolving symlinks. */
  private async isWithinWorkspace(file: string): Promise<boolean> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (isWithinDirectory(file, folder.uri.fsPath) && (await isWithinDirectoryReal(file, folder.uri.fsPath))) return true;
    }
    return false;
  }

  /** Resolves an untrusted path against the connected folder, with the real-path escape check. */
  private async resolveWorkspacePath(targetPath: string): Promise<{ uri: vscode.Uri; path: string } | undefined> {
    const root = this.state.folder?.uri;
    if (!root) return undefined;
    const target = path.isAbsolute(targetPath) ? vscode.Uri.file(targetPath) : vscode.Uri.joinPath(root, targetPath);
    if (!(await this.isWithinWorkspace(target.fsPath))) {
      this.output.warn(`[chat] blocked a file outside the workspace: ${target.fsPath}`);
      return undefined;
    }
    const owner = vscode.workspace.getWorkspaceFolder(target)?.name;
    const relative = vscode.workspace.asRelativePath(target, false);
    return { uri: target, path: owner ? `${owner}/${relative}` : relative };
  }

  private dropzoneEnabled(): boolean {
    return vscode.workspace.getConfiguration("opencode", this.state.folder?.uri).get<boolean>("dropzone", true);
  }

  private postConnection(status: ConnectionStatus = this.state.status, error = this.state.lastError): void {
    this.post({
      type: "connection",
      status,
      error,
      version: this.state.version,
      compatibility: checkCompatibility(this.state.version),
      compatibilityDismissed: !!this.state.version && this.ctx.globalState.get<string>(COMPAT_DISMISSED_KEY) === this.state.version,
      contract: this.state.contract,
      contractDismissed: this.ctx.globalState.get<string>(CONTRACT_DISMISSED_KEY) === contractSignature(this.state.contract),
    });
  }

  /** Recompute the contract report from all observations collected so far. */
  private observeContract(observations: Partial<ContractObservations>): void {
    this.state.contractObservations = { ...this.state.contractObservations, ...observations };
    this.state.contract = checkContract(this.state.contractObservations);
  }

  private setStatus(status: ConnectionStatus, error?: UiError): void {
    this.state.status = status;
    this.state.lastError = error;
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
    // Every fetch below belongs to this connection; a later folder/session change must cancel it.
    this.abortConnectionRequests();
    this.state.connectionAbort = new AbortController();
    this.catalog.resetWarmUp();
    this.fileIndex?.dispose();
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.fileIndex = folders.length > 0 ? new FileIndex(folders, this.ctx.workspaceState) : undefined;
    this.supervisor.openStream(
      conn,
      (event) => this.onEvent(event as ServerEvent),
      (status, error) => this.supervisor.onStreamStatus(status, error),
    );
    await this.sessionService.loadAll();
    this.supervisor.markLoaded(conn);
    this.sessionService.startLivePoll();
  }

  /** OpenCode registers plugin catalog items only once a session exists; keep the picker fresh. */

  /**
   * Applies only the messages added since the last load. The SSE stream is live-only and has no
   * replay, but the history endpoint can find the overlap by id (`order=desc`). When nothing (or
   * only a few messages) changed, the webview keeps its scroll position, attachments and draft
   * instead of being rebuilt from a full `session` payload.
   *
   * Returns `false` when the overlap is unknown (history trimmed/compacted) so the caller falls
   * back to a full load. This is best-effort: a failed tail fetch must never lose a conversation.
   */

  /** Live stream has no replay: re-fetch the current session after a reconnect. */

  /**
   * Manual sync from the header button: an authoritative reload from the server, meant to repair a
   * chat whose live state drifted. Unlike the visibility top-up, this rebuilds the webview state.
   * The completion notice is sent in `finally` so the button can never stay stuck on "syncing".
   */

  /**
   * The SSE stream is scoped to the server process we connected to. Another client (e.g. the TUI
   * running as a separate process) writes sessions to the same on-disk storage but emits no event
   * on our stream, so its prompts are invisible until a manual Sync/Reconnect re-reads history.
   * Poll the open session's tail instead and fold new messages in through the same `sessionDelta`
   * path used on reconnect, so an external conversation shows up live while the chat is visible.
   */

  /** Exposed for integration tests: run one poll now, independent of visibility and event quiet. */

  /** Exposed for integration tests: force the reconnect-style resync without touching VS Code UI. */

  /** Integration-test hooks (kept on the controller's public API). */
  pollNow(): Promise<void> {
    return this.sessionService.pollNow();
  }

  resyncNow(): Promise<void> {
    return this.sessionService.resyncNow();
  }

  // ---- subagents --------------------------------------------------------------------------

  /**
   * A child has no separate toggle of its own: it inherits the chat's auto-approve choice. Without
   * this, a permission asked by a subagent would stay pending forever — the child session is not
   * `this.state.sessionId`, so `PermissionService.enabled(childId)` would fall back to the global setting
   * even when the user explicitly turned auto-approve on (or off) for this chat.
   */

  /** Post a live event to the session that owns it: the main chat, or a tracked subagent's view. */
  private postSessionEvent(sid: string, event: ServerEvent): void {
    this.subagents.postEvent(sid, event);
  }

  // ---- events -----------------------------------------------------------------------------

  private onEvent(event: ServerEvent): void {
    this.eventRouter.route(event);
  }

  /** Cancel all deferred work from the previous connection/session before switching or resetting. */
  private clearTimers(): void {
    this.lifecycle.clearAll();
    this.state.catalogRetries = 0;
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
    const folder = this.state.folder;
    if (!client || !folder) return;
    const directory = folder.uri.fsPath;
    this.state.deleteAllAbort?.abort();
    const abort = new AbortController();
    this.state.deleteAllAbort = abort;
    const token = this.deleteGeneration.current();
    const stale = () => abort.signal.aborted || !this.deleteGeneration.is(token) || this.state.folder !== folder || this.client !== client;
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    try {
      let exhausted = false;
      for (let page = 0; page < MAX_DELETE_PAGES; page++) {
        if (stale()) return;
        const { items, next } = await client.listSessionsPage(directory, 100, cursor, abort.signal);
        if (stale()) return;
        for (const info of items) ids.add(info.id);
        if (ids.size > MAX_DELETE_IDS) throw new Error("Too many sessions to delete");
        if (!next || seenCursors.has(next)) {
          exhausted = true;
          break;
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (!exhausted) throw new Error("Too many session pages to delete");

      const currentId = this.state.sessionId;
      const deleted: string[] = [];
      for (const id of ids) {
        if (stale()) return;
        try {
          await client.deleteSession(id);
          deleted.push(id);
          await this.permissions.write(id, undefined);
        } catch (err) {
          // A child already removed with its parent (or a stale session) must not abort the cleanup.
          this.output.warn(`[chat] failed to delete session ${id}: ${String(err)}`);
        }
      }
      if (stale()) return;

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
    } finally {
      if (this.state.deleteAllAbort === abort) this.state.deleteAllAbort = undefined;
    }
  }

  /** Ask the server to compact the current session (runs at the next step boundary). */
  async compact(): Promise<void> {
    await this.promptActions.compact();
  }

  /**
   * Roll a session back to the turn opened by `messageID`. OpenCode stages a boundary (optionally
   * restoring files), then `commit` drops the boundary message and everything after it. Public so
   * tests can exercise the flow without the native confirmation dialog.
   */
  async revertToTurn(sessionId: string, messageID: string, text: string, files: boolean): Promise<void> {
    await this.promptActions.revertToTurn(sessionId, messageID, text, files);
  }

  /** Shared boundary stage/commit/reload, used by both rollback and regenerate. */

  /**
   * Drop the reply after `messageID` without touching files, then resend the original prompt.
   * The model/agent selection stays as the user left it, so the retry uses the current settings.
   */

  /**
   * Copy the conversation up to `messageID` into a new sibling session and open it. The original
   * keeps its full history and files, so unlike a rollback this is a non-destructive "what if".
   */

  /**
   * `fast` is used by the first prompt: the user's text must reach the server without waiting for
   * catalog/session-list/diff round-trips. Those still run, but fire-and-forget with a generation
   * guard, so the webview is published as soon as history is available.
   */

  // ---- commands ---------------------------------------------------------------------------

  /**
   * One teardown path for "the current work no longer matters". Callers used to repeat a different
   * subset of these steps in a different order; forgetting one was the source of stale-state races.
   */

  /** A folder switch, server reset or dispose also ends the connection epoch and the picker. */
  private invalidateConnection(): void {
    this.lifecycle.generations.connect.bump();
    this.lifecycle.generations.sessions.bump();
    // A bulk delete belongs to one folder/connection; a new session within the same connection must
    // not cancel it (server events can legitimately open a session while the walk is in progress).
    this.deleteGeneration.bump();
    this.state.deleteAllAbort?.abort();
    this.sessionList.reset();
    this.sessionList.cancelSearch();
    this.sessionService.invalidateSessionState();
  }

  async newSession(): Promise<void> {
    this.sessionService.invalidateSessionState();
    // No session is open any more: polling its tail would be a no-op every two seconds until the
    // next load. Loading that session starts the poll again.
    this.state.sessionId = undefined;
    this.subagents.reset();
    if (this.state.folder) await this.ctx.workspaceState.update(SESSION_KEY(this.state.folder.uri.toString()), undefined);
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.refreshActions.publishInbox([]);
    this.permissionActions.post();
    this.catalog.publish();
    await this.refreshSessions().catch(() => {});
    this.post({ type: "focusInput" });
  }

  async reconnect(): Promise<void> {
    if (this.trustBlocked()) {
      this.postUntrusted();
      return;
    }
    this.sessionService.invalidateSessionState();
    await this.supervisor.reconnect();
  }

  /** Tears down the server/stream/client without binding a new connection. */
  private async detachServers(): Promise<void> {
    this.invalidateConnection();
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
    if (folder?.uri.toString() === this.state.folder?.uri.toString()) return;
    this.invalidateConnection();
    this.state.sessionId = undefined;
    // Detach the old server before connecting to the new folder: its late state notifications must
    // not race the new connection (the supervisor still re-checks ownership when it installs one).
    this.supervisor.detachServerOnly();
    this.state.folder = folder;
    this.postInit();
    this.post({ type: "session", session: null });
    this.post({ type: "changedFiles", files: [] });
    this.permissionActions.post();
    await this.connect();
  }

  async setPassword(): Promise<void> {
    await this.serverActions.setPassword();
  }

  /**
   * First-run help. A bare docs link used to be a dead end: now the command is visible and
   * copyable, Windows users get platform-specific instructions, and the retry stays in the flow.
   */

  /** Explain the terminal hand-off before it happens: sign-in is a prerequisite, not a side quest. */

  async runAction(id: ActionId): Promise<void> {
    await this.serverActions.run(id);
  }

  // ---- webview messages -------------------------------------------------------------------

  private async handle(msg: WebviewMessage): Promise<void> {
    await this.commandHandler.handle(msg);
  }

  /**
   * Put a refused prompt back in the composer and offer an exact-payload retry.
   *
   * `generation` is the token published as "running" by `send()`. The server never accepted the
   * prompt, so no terminal event will close that state: we must do it here or the status bar keeps
   * spinning forever. The guard prevents an asynchronously restored draft from overwriting a newer
   * turn that started in the meantime.
   */

  /** Returns false when the prompt never reached the server (no notice is posted for stale loads). */

  async dispose(): Promise<void> {
    // Use the hard detach: `detachServerOnly()` left `connecting` alive, so a `server.ensure()` still
    // in flight could complete after teardown, pass its stale check and open a fresh SSE stream +
    // poll interval against a disposed controller. The hard path bumps the connect generation.
    this.invalidateConnection();
    await this.attachments.dispose();
    await this.supervisor.detach();
    this.fileIndex?.dispose();
    this.chatViews.dispose();
    for (const d of this.disposables) d.dispose();
  }

  // Exposed for integration tests.
  get debugState() {
    const storedSession = this.state.folder
      ? this.ctx.workspaceState.get<string>(SESSION_KEY(this.state.folder.uri.toString()))
      : undefined;
    return {
      status: this.state.status,
      sessionId: this.state.sessionId,
      storedSession,
      folder: this.state.folder?.uri.fsPath,
      baseUrl: this.client?.conn.baseUrl,
      livePolling: this.lifecycle.hasInterval("livePoll"),
    };
  }
}
