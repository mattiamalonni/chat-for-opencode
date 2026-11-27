import * as path from "node:path";
import * as vscode from "vscode";
import { OpenCodeClient } from "../client/http";
import { CatalogService } from "./catalogService";
import { ConnectionSupervisor } from "./connectionSupervisor";
import { FileIconThemeService, type LanguageContribution } from "./fileIconTheme";
import { ChatLifecycle } from "./lifecycle";
import { Generation } from "./generation";
import { describeServerError, ServerError, type ServerHandle, type ServerState } from "../server/server";
import type { CredentialSummary, ServerEvent } from "../shared/api";

import { checkCompatibility, compatibilityKey } from "../shared/compatibility";

import { checkContract, contractSignature, type ContractObservations } from "../shared/contract";
import { isWebviewMessage } from "../shared/protocolGuards";
import type { ActionId, Attachment, ConnectionStatus, HostMessage, UiError, WebviewMessage } from "../shared/protocol";

import { AttachmentService } from "./attachmentService";
import { SessionListService, type SessionSearchResult } from "./sessionListService";
import { SubagentTracker } from "./subagentTracker";
import { ContextTracker, FileIndex } from "./context";
import { PromptLibraryService } from "./promptLibrary";
import { formatPromptDiff, formatPromptDiagnostics } from "./promptContext";
import { ApplyCodeService } from "./applyCode";
import { workingDiff } from "./gitDiff";
import { ChatViews, type ChatWebview } from "./views";
import { DiffService } from "./diff";

import { PermissionService } from "./permissionService";
import { SessionOwnershipService } from "./sessionOwnership";

import { BoundedSet } from "../shared/boundedSet";
import { ChatEventRouter } from "./eventRouter";
import { ExternalAttentionService } from "./externalAttention";
import { JobTracker } from "./jobTracker";
import { ChatCommandHandler } from "./commandHandler";
import { WebviewMessageQueue } from "./messageQueue";
import { ExecutionStateService, type ExecutionState } from "./executionState";
import { createControllerState } from "./services/controllerState";
import { isWithinWorkspace, resolveWithinWorkspace } from "./workspacePath";
import { ChatDraftActions } from "./services/draftActions";
import { ChatFileActions } from "./services/fileActions";
import { ChatServerActions } from "./services/serverActions";
import { ChatBulkDelete } from "./services/bulkDelete";
import { ChatConnectionService } from "./services/connectionService";
import { ChatPromptActions } from "./services/promptActions";
import { ChatSessionService } from "./services/sessionService";
import { ChatPermissionActions } from "./services/permissionActions";
import { ChatRefreshActions } from "./services/refreshActions";

export type { ExecutionState, ExecutionStatus, TerminalStatus } from "./executionState";

import { SESSION_KEY, COMPAT_DISMISSED_KEY, CONTRACT_DISMISSED_KEY } from "./storageKeys";

import { ServerRegistry, toUiError, translatedStrings } from "./services/controllerSupport";

export { ServerRegistry, translatedStrings } from "./services/controllerSupport";

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
  private readonly connectionService: ChatConnectionService;
  private readonly bulkDelete: ChatBulkDelete;
  /** All live chats and their listeners; see views.ts. */
  private readonly chatViews: ChatViews;
  /** SDK host, generated client and event-stream ownership; see connectionSupervisor.ts. */
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
  private readonly disposables: vscode.Disposable[] = [];
  /** Inline permissions: workspace-wide auto-approve, granted ids and pending-request filtering. */
  private readonly permissions: PermissionService;
  /** Maps shared-stream sessions to this window's workspace so foreign events are ignored. */
  private readonly ownership: SessionOwnershipService;
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
  /** Pending requests from other clients on the same server; see externalAttention.ts. */
  private readonly externalAttention: ExternalAttentionService;
  /** Running background jobs of all kinds (shell, subagent, image, video, codemode). */
  private readonly jobs = new JobTracker();

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
        return this.connectionService.useConnection(conn, stale);
      },
      onStreamReconnect: () => {
        void this.sessionService.resync();
      },
      onDetached: () => {
        this.state.lastKnownMessage = undefined;
        this.sessionService.stopLivePoll();
        this.connectionService.clearTimers();
        // A different server (folder switch/reconnect) cannot answer requests from the old one.
        this.externalAttention.reset();
        this.jobs.reset();
      },
      toUiError: (err, fallback) => {
        // SDK host diagnostics are written here only, never forwarded to the webview.
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
      () => this.permissions.enabled(),
      () => this.jobs.pending(),
    );
    this.externalAttention = new ExternalAttentionService(
      (msg) => this.post(msg),
      (sid) => this.sessionList.titleOf(sid),
    );
    this.context = new ContextTracker((items) => this.post({ type: "context", items }));

    const readUri = async (uri: vscode.Uri): Promise<string | undefined> => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        return undefined;
      }
    };
    const writeUri = async (uri: vscode.Uri, content: string): Promise<void> => {
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
    };
    const warn = (message: string) => this.output.warn(message);
    const info = (message: string) => void vscode.window.showInformationMessage(message);
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
      read: readUri,
      preview: (uri, current, proposed) => this.diffs.openProposal(uri, current, proposed),
      confirm: async () => {
        const accept = vscode.l10n.t("Accept");
        const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Apply this change?"), accept, vscode.l10n.t("Reject"));
        return choice === accept;
      },
      write: writeUri,
      warn,
      info,
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
        // The prompt catalog is posted before the trust check, and git honours repository config
        // (e.g. `core.fsmonitor`) that can run arbitrary commands: never spawn it untrusted.
        if (!cwd || this.trustBlocked()) return "";
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
    this.permissions = new PermissionService(
      ctx,
      () => this.state.folder,
      (line) => output.info(line),
    );
    this.ownership = new SessionOwnershipService(
      () => this.client,
      () => this.state.folder?.uri.fsPath,
      () => this.state.sessionId,
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
      ownership: {
        owns: (id) => this.ownership.owns(id),
        learn: (raw) => this.ownership.learn(raw),
        forget: (id) => this.ownership.forget(id),
      },
      external: {
        observe: (event, sid, isCurrent, isChild) => this.externalAttention.observe(event, sid, isCurrent, isChild),
        forget: (sid) => {
          this.externalAttention.forget(sid);
        },
      },
      postExternalCard: (event, sid) => this.externalAttention.observe(event, sid, false, false),
      jobs: { observe: (event) => this.jobs.observe(event) },
      execution: this.execution,
      attention: this.announcedHiddenAttention,
      scheduleInbox: () => this.refreshActions.scheduleInbox(),
      scheduleSessions: () => this.refreshActions.scheduleSessions(),
      scheduleReconcile: () => this.sessionService.scheduleReconcile(),
      scheduleChanges: () => this.refreshActions.scheduleChanges(),
      refreshSlashItems: async () => {
        await this.sessionService.refreshSlashItems();
      },
      autoApprove: (event, sid, onFailure) => this.permissionActions.autoApprove(event, sid, onFailure),
      newSession: () => this.connectionService.newSession(),
    });
    this.disposables.push(
      this.jobs.onDidChange(() => {
        this.post({ type: "jobs", jobs: this.jobs.pending() });
        this.refreshActions.scheduleSessions();
      }),
    );
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
      connect: () => this.connectionService.connect(),
      loadAll: () => this.sessionService.loadAll(),
      loadSession: (info, stale) => {
        this.ownership.learn(info);
        return this.sessionService.loadSession(info, stale);
      },
      send: (text, attachments, context, delivery, sessionId) => this.promptActions.send(text, attachments, context, delivery, sessionId),
      newSession: () => this.connectionService.newSession(),
      saveDraft: (sid, text) => this.draftActions.save(sid, text),
      refreshSessions: () => this.refreshSessions(),
      loadMoreSessions: () => this.loadMoreSessions(),
      setAutoApprove: (enabled) => this.permissionActions.set(enabled),
      dropFiles: (files) => this.fileActions.dropFiles(files),
      pickFiles: () => this.fileActions.pickFiles(),
      openFile: (file) => this.fileActions.openFile(file),
      openToolFile: (file) => this.fileActions.openToolFile(file),
      openAttachment: (uri) => this.fileActions.openAttachment(uri),
      openLink: (href) => this.fileActions.openLink(href),
      runAction: (id) => this.serverActions.run(id),
      switchFolder: (folder) => this.connectionService.switchFolder(folder),
      refreshChanges: () => this.refreshActions.refreshChanges(),
      syncNow: () => this.sessionService.syncNow(),
      compact: async () => {
        await this.promptActions.compact();
      },
      revertToTurn: (sessionId, messageID, text, files) => this.promptActions.revertToTurn(sessionId, messageID, text, files),
      forkConversation: () => this.promptActions.forkConversation(),
      regenerateTurn: (sessionId, messageID, text, attachments) =>
        this.promptActions.regenerateTurn(sessionId, messageID, text, attachments),
      refreshInbox: (sid) => this.refreshActions.refreshInbox(sid),
      deleteAllSessions: () => this.deleteAllSessions(),
      catalog: this.catalog,
      sessionList: this.sessionList,
      subagents: this.subagents,
      execution: this.execution,
      generation: this.lifecycle.generations.load,
      getFileIndex: () => this.fileIndex,
      applyCode: (text, targetPath) => this.applyCode.apply(text, targetPath),
      usePrompt: (id) => this.promptActions.usePrompt(id),
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
      getDirectory: () => this.state.folder?.uri.fsPath,
      post: (msg) => this.post(msg),
      postSessionEvent: (sid, event) => this.postSessionEvent(sid, event),
      postExternal: (event, sid) => this.externalAttention.observe(event, sid, false, false),
      forgetExternalRequest: (requestId) => this.externalAttention.forgetRequest(requestId),
      log: (line) => output.info(line),
    });
    this.fileActions = new ChatFileActions({
      state: this.state,
      attachments: this.attachments,
      post: (msg) => this.post(msg),
      logWarn: (line) => output.warn(line),
      isWithinWorkspace: (file) => isWithinWorkspace(file),
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
      reconnect: () => this.connectionService.reconnect(),
      openConnect: () => void vscode.commands.executeCommand("opencode.connect"),
      resetServers: () => this.connectionService.resetServers(),
      newSession: () => this.connectionService.newSession(),
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
      abortConnectionRequests: () => this.connectionService.abortConnectionRequests(),
      clearTimers: () => this.connectionService.clearTimers(),
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
      sessionList: this.sessionList,
      prompts: this.prompts,
      fileActions: this.fileActions,
      draftActions: this.draftActions,
      sessionService: this.sessionService,
      output,
      learnSession: (info) => this.ownership.learn(info),
      getClient: () => this.client,
      getServer: () => this.server,
      connect: () => this.connectionService.connect(),
      prefillDraft: (text, attachments) => this.prefillDraft(text, attachments),
      post: (msg) => this.post(msg),
    });
    this.connectionService = new ChatConnectionService({
      state: this.state,
      ctx,
      supervisor: this.supervisor,
      lifecycle: this.lifecycle,
      catalog: this.catalog,
      subagents: this.subagents,
      permissions: this.permissions,
      sessionList: this.sessionList,
      chatViews: this.chatViews,
      deleteGeneration: this.deleteGeneration,
      sessionService: this.sessionService,
      permissionActions: this.permissionActions,
      refreshActions: this.refreshActions,
      getFileIndex: () => this.fileIndex,
      setFileIndex: (index) => {
        this.fileIndex = index;
      },
      postInit: () => this.postInit(),
      post: (msg) => this.post(msg),
      onEvent: (event) => this.onEvent(event),
      postUntrusted: () => this.postUntrusted(),
      trustBlocked: () => this.trustBlocked(),
      setStatus: (status) => this.setStatus(status),
      refreshSessions: () => this.refreshSessions(),
    });
    this.bulkDelete = new ChatBulkDelete({
      state: this.state,
      deleteGeneration: this.deleteGeneration,
      sessionList: this.sessionList,
      workspaceState: ctx.workspaceState,
      getClient: () => this.client,
      logWarn: (line) => output.warn(line),
      refreshSessions: () => this.refreshSessions(),
      newSession: () => this.connectionService.newSession(),
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
          void this.connectionService.switchFolder(this.pickFolder());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("opencode.autoApprovePermissions")) {
          this.permissionActions.post();
          if (this.permissions.enabled()) void this.permissionActions.approvePending();
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

  /** Search session titles and message bodies across the workspace (delegated to the picker service). */
  async searchSessions(query: string, maxSessions = 200): Promise<SessionSearchResult[]> {
    // A new query supersedes the previous one; do not leave its history fetches running.
    return this.sessionList.search(query, maxSessions);
  }

  /** Opens the session a search hit came from and asks the webview to scroll to its message. */
  async openSearchResult(result: SessionSearchResult): Promise<void> {
    await vscode.commands.executeCommand("opencode.chatView.focus");
    if (result.sessionId !== this.state.sessionId) await this.receive({ type: "selectSession", id: result.sessionId });
    if (result.messageId) this.post({ type: "revealMessage", messageId: result.messageId, sessionId: result.sessionId });
    // The picker had focus: hand it to the composer so the next keystroke starts a prompt.
    this.post({ type: "focusInput" });
  }

  /** Fills the composer from an editor context action, attaching the selection it came from. */
  prefillDraft(text: string, attachments: Attachment[]): void {
    this.post({ type: "prefillDraft", sessionId: this.state.sessionId ?? undefined, text, attachments });
  }

  /**
   * Serializes webview messages: a late `ready`/loadAll must not race a prompt and drop its events.
   * Open/copy actions skip it; see messageQueue.ts.
   */
  private readonly messageQueue = new WebviewMessageQueue();

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
    try {
      await this.messageQueue.run(msg, (m) => this.handle(m));
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

  /** Same HTTP client and password as the chat, for host features that call other server APIs. */
  get apiClient(): OpenCodeClient | undefined {
    return this.client;
  }

  /**
   * Saved accounts from the server, shared by the status bar, the Account picker and the Connect
   * panel. Reuses the live client; only starts a connection when there isn't one yet.
   */
  async credentials(): Promise<CredentialSummary[]> {
    let client = this.client;
    if (!client) {
      await this.connect();
      client = this.client;
    }
    return client ? client.credentials() : [];
  }

  /** Re-read models and agents after the Connect panel adds or switches a provider. */
  async refreshCatalog(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const [models, defaultModel, agents] = await Promise.all([
      client.models().catch(() => []),
      client.defaultModel().catch(() => null),
      client.agents().catch(() => []),
    ]);
    this.catalog.setModelsAndAgents(models, defaultModel, agents);
    this.catalog.publish();
    await this.catalog.refresh(client);
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

  /** Resolves an untrusted path against the connected folder, with the real-path escape check. */
  private async resolveWorkspacePath(targetPath: string): Promise<{ uri: vscode.Uri; path: string } | undefined> {
    const root = this.state.folder?.uri;
    if (!root) return undefined;
    const target = await resolveWithinWorkspace(root, targetPath);
    if (!target) {
      this.output.warn(`[chat] blocked a file outside the workspace: ${targetPath}`);
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
      compatibilityDismissed:
        !!this.state.version && this.ctx.globalState.get<string>(COMPAT_DISMISSED_KEY) === compatibilityKey(this.state.version),
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
   * An untrusted workspace must never create an OpenCode host or read stored credentials.
   * VS Code returns restricted configuration defaults there, so the gate belongs before any
   * host/secret access.
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
    await this.connectionService.onWorkspaceTrustChanged(trusted);
  }

  /** Starts (or reuses) the server for the current folder and loads everything. */
  connect(): Promise<void> {
    return this.connectionService.connect();
  }

  /** Integration-test hook for late server notifications (see extension.test.ts). */
  onServerState(state: ServerState, server?: ServerHandle): void {
    this.connectionService.onServerState(state, server);
  }

  /** Integration-test hooks (kept on the controller's public API). */
  pollNow(): Promise<void> {
    return this.sessionService.pollNow();
  }

  resyncNow(): Promise<void> {
    return this.sessionService.resyncNow();
  }

  // ---- subagents --------------------------------------------------------------------------

  /** Post a live event to the session that owns it: the main chat, or a tracked subagent's view. */
  private postSessionEvent(sid: string, event: ServerEvent): void {
    this.subagents.postEvent(sid, event);
  }

  // ---- events -----------------------------------------------------------------------------

  private onEvent(event: ServerEvent): void {
    this.eventRouter.route(event);
  }

  /**
   * The event stream is live-only, so a missed terminal event can leave the webview showing an
   * incomplete turn forever. After each turn, re-read the session and replace the webview state.
   * Skipped when another prompt starts meanwhile, since its live events are newer than the snapshot.
   */

  async refreshSessions(): Promise<void> {
    await this.sessionList.refresh();
    // Keep the ownership map warm so the first event of a session in this folder is not dropped.
    void this.ownership.prime().catch(() => undefined);
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
    await this.bulkDelete.run();
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

  // ---- commands ---------------------------------------------------------------------------

  /** A folder switch, server reset or dispose also ends the connection epoch and the picker. */

  async newSession(): Promise<void> {
    await this.connectionService.newSession();
  }

  async reconnect(): Promise<void> {
    await this.connectionService.reconnect();
  }

  /** Tears down the server/stream/client without binding a new connection. */

  async resetServers(): Promise<void> {
    await this.connectionService.resetServers();
  }

  /** The "Stop Server" command: stop for good, no immediate reconnect. The next prompt reconnects. */
  async stopServer(): Promise<void> {
    await this.connectionService.stopServer();
  }

  async switchFolder(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    this.ownership.reset();
    await this.connectionService.switchFolder(folder);
  }

  async setPassword(): Promise<void> {
    await this.serverActions.setPassword();
  }

  /** Explain the terminal hand-off before it happens: sign-in is a prerequisite, not a side quest. */

  async runAction(id: ActionId): Promise<void> {
    await this.serverActions.run(id);
  }

  // ---- webview messages -------------------------------------------------------------------

  private async handle(msg: WebviewMessage): Promise<void> {
    await this.commandHandler.handle(msg);
  }

  /** Returns false when the prompt never reached the server (no notice is posted for stale loads). */

  async dispose(): Promise<void> {
    // Use the hard detach: `detachServerOnly()` left `connecting` alive, so a `server.ensure()` still
    // in flight could complete after teardown, pass its stale check and open a fresh event stream +
    // poll interval against a disposed controller. The hard path bumps the connect generation.
    this.connectionService.invalidateConnection();
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
