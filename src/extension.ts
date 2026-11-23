import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { ChatController, ServerRegistry, type ExecutionStatus, type SessionSearchResult } from "./chat/controller";
import { DIFF_SCHEME, DiffService } from "./chat/diff";
import { fileAttachment, selectionAttachment } from "./chat/context";
import { diffPrompt, workingDiff, type DiffIntent, type WorkingDiff } from "./chat/gitDiff";
import { usageLabel, usageTooltip, usageUpdateFromMessage, type SessionUsage } from "./chat/usageStatus";
import { openSessionCommand } from "./chat/terminal";
import { diagnosticCodeActions, EXPLAIN_DIAGNOSTIC_COMMAND, FIX_DIAGNOSTIC_COMMAND, type DiagnosticCommandArgs } from "./chat/codeActions";
import { ChatViewProvider } from "./chat/viewProvider";
import { cleanupOrphanServers } from "./server/orphans";

const execFileAsync = promisify(execFile);

type AuthMenuItem = vscode.QuickPickItem & { command?: "login" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuthLogins(output: string): vscode.QuickPickItem[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Expected an array from `opencode auth list --format json`.");

  const items: vscode.QuickPickItem[] = [];
  for (const integration of parsed) {
    if (!isRecord(integration) || typeof integration.id !== "string") {
      throw new Error("Unexpected integration format from `opencode auth list --format json`.");
    }
    if (integration.id !== "opencode") continue;
    if (typeof integration.name !== "string" || !Array.isArray(integration.connections)) {
      throw new Error("Unexpected OpenCode login format from `opencode auth list --format json`.");
    }
    for (const connection of integration.connections) {
      if (!isRecord(connection)) throw new Error("Unexpected login format from `opencode auth list --format json`.");
      const description = typeof connection.label === "string" ? connection.label : undefined;
      const detail = [connection.method, connection.type].filter((value): value is string => typeof value === "string").join(" · ");
      items.push({ label: integration.name, description, detail: detail || undefined });
    }
  }
  return items;
}

let registry: ServerRegistry | undefined;
let controller: ChatController | undefined;

export interface ExtensionApi {
  controller: ChatController;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const output = vscode.window.createOutputChannel("OpenCode", { log: true });
  const log = (line: string) => output.info(line);
  const recordsDir = path.join(context.globalStorageUri.fsPath, "servers");
  // A server whose extension host died (VS Code crash) cannot clean up after itself. Reap it
  // before starting any new one, but leave servers owned by other live VS Code windows alone.
  void cleanupOrphanServers(recordsDir, log);
  registry = new ServerRegistry(context.secrets, log, recordsDir);
  const diffs = new DiffService((line) => output.warn(line));
  controller = new ChatController(context, registry, diffs, output);
  const chat = controller;
  // Declared here so host commands can warn when a turn is still active; the status bar listener
  // below writes the same variable.
  let executionStatus: ExecutionStatus = "idle";

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  const readAuthLogins = async () => {
    if (!vscode.workspace.isTrusted) throw new Error("Workspace is not trusted");
    const executable = vscode.workspace.getConfiguration("opencode").get<string>("executablePath", "opencode").trim() || "opencode";
    const { stdout } = await execFileAsync(executable, ["auth", "list", "--format", "json"], { timeout: 10_000 });
    return parseAuthLogins(stdout);
  };

  /** A Quick Fix selects the offending lines, then opens the chat with them attached. */
  const runDiffCommand = async (intent: DiffIntent) => {
    const cwd = chat.folderUri?.fsPath;
    if (!cwd || !vscode.workspace.isTrusted) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Open a trusted workspace folder first."));
      return;
    }
    let diff: WorkingDiff | undefined;
    try {
      const title =
        intent === "review"
          ? vscode.l10n.t("Reading git changes for a review…")
          : vscode.l10n.t("Reading git changes for a commit message…");
      diff = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => workingDiff(cwd));
    } catch (err) {
      output.error(`[git] ${String(err)}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not read the git diff. Check that git is installed and this folder is a repository."),
      );
      return;
    }
    if (!diff || !diff.diff.trim()) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No uncommitted changes found in this workspace."));
      return;
    }
    await focusView();
    await chat.receive({ type: "send", text: diffPrompt(diff, intent), attachments: [], context: [] });
  };

  const prefillDiagnostic = async (value: unknown, intent: "fix" | "explain") => {
    if (!value || typeof value !== "object") return;
    const args = value as Partial<DiagnosticCommandArgs>;
    if (
      typeof args.uri !== "string" ||
      typeof args.startLine !== "number" ||
      typeof args.endLine !== "number" ||
      typeof args.message !== "string"
    ) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
    const editor = await vscode.window.showTextDocument(document);
    const lastLine = Math.max(0, editor.document.lineCount - 1);
    const start = new vscode.Position(Math.min(lastLine, Math.max(0, args.startLine - 1)), 0);
    const endLine = Math.min(lastLine, Math.max(0, args.endLine - 1));
    editor.selection = new vscode.Selection(start, editor.document.lineAt(endLine).range.end);
    const attachment = selectionAttachment(editor);
    const prompt =
      intent === "fix" ? vscode.l10n.t("Fix this error: {0}", args.message) : vscode.l10n.t("Explain this error: {0}", args.message);
    await focusView();
    chat.prefillDraft(prompt, attachment ? [attachment] : []);
  };

  // A second, quiet status item keeps the running cost visible even with the sidebar collapsed.
  // It mirrors the server's session usage; the webview's context meter remains the detailed view.
  const usageItem = vscode.window.createStatusBarItem("opencode.usage", vscode.StatusBarAlignment.Right, 99);
  usageItem.name = vscode.l10n.t("OpenCode session usage");
  usageItem.command = "opencode.focus";
  let sessionUsage: SessionUsage | undefined;
  const renderUsage = () => {
    const enabled = vscode.workspace.getConfiguration("opencode").get<boolean>("showUsageInStatusBar", true);
    if (!sessionUsage || !enabled || !vscode.workspace.isTrusted) {
      usageItem.hide();
      return;
    }
    usageItem.text = usageLabel(sessionUsage);
    usageItem.tooltip = usageTooltip(sessionUsage, (message) => vscode.l10n.t(message));
    usageItem.show();
  };
  renderUsage();

  context.subscriptions.push(
    usageItem,
    chat.onDidPost((msg) => {
      const update = usageUpdateFromMessage(msg);
      if (update.kind === "keep") return;
      sessionUsage = update.kind === "set" ? update.usage : undefined;
      renderUsage();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencode.showUsageInStatusBar")) renderUsage();
    }),
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, new ChatViewProvider(context.extensionUri, chat)),
    vscode.window.registerWebviewPanelSerializer("opencode.chat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        chat.attachPanel(panel);
      },
    }),
    // OpenCode's chat meets the user where the problem already is: on the squiggle. These are
    // Quick Fixes only — the prompt is prefilled so nothing is sent without a review.
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      {
        provideCodeActions(document, range, context) {
          return diagnosticCodeActions(document, range, context.diagnostics, {
            t: (message) => vscode.l10n.t(message),
            create: (title, command, args, preferred) => {
              const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
              action.command = { command, title, arguments: [args] };
              action.isPreferred = preferred;
              return action;
            },
          });
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    // 1.99 exposes only the "granted" event: untrusting a workspace requires a window reload, so
    // there is nothing to react to there. Reconnect/prompt paths re-check `isTrusted` themselves.
    vscode.workspace.onDidGrantWorkspaceTrust(() => void chat.onWorkspaceTrustChanged(true)),
    vscode.commands.registerCommand("opencode.newSession", async () => {
      await focusView();
      await chat.newSession();
    }),
    vscode.commands.registerCommand("opencode.restart", async () => {
      const restart = vscode.l10n.t("Restart");
      // A modal showWarningMessage already gets a native Cancel button: adding one as an action
      // would show it twice.
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t("Restart the OpenCode server?"),
        {
          modal: true,
          detail: vscode.l10n.t(
            "The current server and its event stream are torn down and started again. Running turns are interrupted and pending approvals are cancelled.",
          ),
        },
        restart,
      );
      if (choice === restart) await chat.resetServers();
    }),
    vscode.commands.registerCommand("opencode.install", () => chat.runAction("install")),
    vscode.commands.registerCommand("opencode.openSettings", () => chat.runAction("openSettings")),
    vscode.commands.registerCommand("opencode.compact", () => chat.compact()),
    vscode.commands.registerCommand("opencode.searchSessions", async () => {
      const query = await vscode.window.showInputBox({
        title: vscode.l10n.t("Search all OpenCode conversations"),
        prompt: vscode.l10n.t("Search session titles and messages in this workspace"),
      });
      if (!query?.trim()) return;
      const hits = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Searching conversations…") },
        () => chat.searchSessions(query),
      );
      if (hits.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t("No conversation matched “{0}”.", query));
        return;
      }
      type HitItem = vscode.QuickPickItem & { hit: SessionSearchResult };
      const items: HitItem[] = hits.map((hit) => ({
        label: hit.title,
        description: new Date(hit.updated).toLocaleString(),
        detail: hit.snippet,
        hit,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("Conversations matching “{0}”", query),
        matchOnDetail: true,
      });
      if (picked) await chat.openSearchResult(picked.hit);
    }),
    // Single-modal MRU switcher: recent sessions appear immediately, and typing extends the search
    // to all conversations in place instead of opening a second dialog on top of the first.
    vscode.commands.registerCommand("opencode.quickSwitchSession", () => {
      type Pick = vscode.QuickPickItem & { sessionId: string; messageId?: string };
      const picker = vscode.window.createQuickPick<Pick>();
      const recent = chat.recentSessions();
      const recentItems = (query: string): Pick[] =>
        recent
          .filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()))
          .map((s) => ({
            label: s.title || vscode.l10n.t("Untitled session"),
            description: s.needsInput
              ? vscode.l10n.t("Needs your input")
              : s.busy
                ? vscode.l10n.t("Running")
                : new Date(s.updated).toLocaleString(),
            sessionId: s.id,
          }));
      const hitItems = (hits: SessionSearchResult[]): Pick[] =>
        hits.map((hit) => ({
          label: hit.title,
          description: new Date(hit.updated).toLocaleString(),
          detail: hit.snippet,
          sessionId: hit.sessionId,
          messageId: hit.messageId,
        }));
      picker.title = vscode.l10n.t("Switch OpenCode session");
      picker.placeholder = vscode.l10n.t("Type to filter recent sessions, or search all conversations…");
      picker.items = recentItems("");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let token = 0;
      picker.onDidChangeValue((value) => {
        if (timer) clearTimeout(timer);
        const query = value.trim();
        const local = recentItems(query);
        picker.items = local;
        if (!query) return;
        const current = ++token;
        timer = setTimeout(() => {
          void chat.searchSessions(query).then((hits) => {
            if (current !== token) return;
            const known = new Set(local.map((item) => item.sessionId));
            picker.items = [...local, ...hitItems(hits).filter((hit) => !known.has(hit.sessionId))];
          });
        }, 250);
      });
      picker.onDidAccept(async () => {
        const picked = picker.activeItems[0];
        picker.hide();
        if (!picked) return;
        await chat.openSearchResult({
          sessionId: picked.sessionId,
          title: picked.label,
          snippet: picked.detail ?? "",
          updated: Date.now(),
          messageId: picked.messageId,
        });
      });
      picker.onDidHide(() => {
        if (timer) clearTimeout(timer);
        token++;
        picker.dispose();
      });
      picker.show();
    }),
    vscode.commands.registerCommand("opencode.focus", async () => {
      await focusView();
      chat.post({ type: "focusInput" });
    }),
    // Bound to the status bar while a turn is running, so the spinner itself is actionable.
    vscode.commands.registerCommand("opencode.stopTurn", () => void chat.receive({ type: "abort" })),
    vscode.commands.registerCommand("opencode.openChatInEditor", () => chat.openChatInEditor()),
    vscode.commands.registerCommand("opencode.ask", async () => {
      const text = await vscode.window.showInputBox({
        title: vscode.l10n.t("Ask OpenCode"),
        prompt: vscode.l10n.t("Send a prompt without leaving your editor"),
        placeHolder: vscode.l10n.t("Describe what you want OpenCode to do…"),
      });
      if (!text?.trim()) return;
      const editor = vscode.window.activeTextEditor;
      const attachment =
        editor && !editor.selection.isEmpty && editor.document.uri.scheme === "file" ? selectionAttachment(editor) : undefined;
      await focusView();
      // Fill the composer instead of sending straight away: the selection must travel with the
      // prompt and the user gets to review (or extend) it before it reaches the agent.
      chat.prefillDraft(text.trim(), attachment ? [attachment] : []);
    }),
    vscode.commands.registerCommand("opencode.reviewChanges", () => void runDiffCommand("review")),
    vscode.commands.registerCommand("opencode.commitMessage", () => void runDiffCommand("commit")),
    vscode.commands.registerCommand("opencode.continueInTerminal", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showInformationMessage(vscode.l10n.t("Trust this workspace before using OpenCode."));
        return;
      }
      if (executionStatus === "running" || executionStatus === "needsInput") {
        const anyway = vscode.l10n.t("Open in terminal anyway");
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            "This session is still active in the chat. A terminal is a second client on the same session; both can write to it.",
          ),
          anyway,
        );
        if (choice !== anyway) return;
      }
      const executable = vscode.workspace.getConfiguration("opencode").get<string>("executablePath", "opencode").trim() || "opencode";
      const sessionId = chat.currentSessionId;
      let command: string;
      try {
        command = openSessionCommand(executable, sessionId);
      } catch (err) {
        output.error(`[terminal] ${String(err)}`);
        void vscode.window.showErrorMessage(
          vscode.l10n.t("The configured OpenCode executable path cannot be quoted safely in a terminal."),
        );
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: sessionId ? vscode.l10n.t("OpenCode session") : vscode.l10n.t("OpenCode"),
        cwd: chat.folderUri,
      });
      terminal.show();
      terminal.sendText(command);
    }),
    vscode.commands.registerCommand(FIX_DIAGNOSTIC_COMMAND, (args: unknown) => void prefillDiagnostic(args, "fix")),
    vscode.commands.registerCommand(EXPLAIN_DIAGNOSTIC_COMMAND, (args: unknown) => void prefillDiagnostic(args, "explain")),
    vscode.commands.registerCommand("opencode.askAboutFile", async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const attachment = uri && fileAttachment(uri);
      if (!attachment) {
        void vscode.window.showInformationMessage(vscode.l10n.t("Open a file in the editor first."));
        return;
      }
      await focusView();
      chat.prefillDraft(vscode.l10n.t("What does this file do? How could it be improved?"), [attachment]);
    }),
    vscode.commands.registerCommand("opencode.account", async () => {
      let logins: vscode.QuickPickItem[];
      try {
        logins = await readAuthLogins();
      } catch (err) {
        output.error(`[auth] failed to read OpenCode logins: ${String(err)}`);
        authLogins = undefined;
        updateStatusTooltip();
        const action = await vscode.window.showErrorMessage(
          vscode.l10n.t("Could not load OpenCode login information. Check the OpenCode installation and executable path."),
          vscode.l10n.t("Open settings"),
        );
        if (action) await vscode.commands.executeCommand("workbench.action.openSettings", "opencode.executablePath");
        return;
      }

      authLogins = logins;
      updateStatusTooltip();
      const items: AuthMenuItem[] = logins.map((login) => ({ ...login }));
      if (items.length) items.push({ label: vscode.l10n.t("Actions"), kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: vscode.l10n.t("Sign in or add an OpenCode login"),
        description: vscode.l10n.t("Run opencode auth login"),
        command: "login",
      });
      const selection = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("OpenCode login"),
        placeHolder: logins.length ? vscode.l10n.t("Saved OpenCode logins") : vscode.l10n.t("No saved OpenCode login found"),
      });
      if (selection?.command === "login") await chat.runAction("login");
    }),
    vscode.commands.registerCommand("opencode.addSelectionToChat", async () => {
      await focusView();
      if (!chat.addSelection(vscode.window.activeTextEditor)) {
        void vscode.window.showInformationMessage(vscode.l10n.t("Select some text in a file first."));
      }
    }),
    ...[
      ["opencode.explainSelection", "Explain this code"],
      ["opencode.findBugsSelection", "Find bugs in this code"],
      ["opencode.writeTestsSelection", "Write tests for this code"],
      ["opencode.optimizeSelection", "Optimize this code"],
    ].map(([id, prompt]) =>
      vscode.commands.registerCommand(id, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== "file") {
          void vscode.window.showInformationMessage(vscode.l10n.t("Select some text in a file first."));
          return;
        }
        const attachment = selectionAttachment(editor);
        await focusView();
        chat.prefillDraft(vscode.l10n.t(prompt), attachment ? [attachment] : []);
      }),
    ),
    vscode.commands.registerCommand("opencode.addFileToChat", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "file") return;
      await focusView();
      await chat.addFile(target);
    }),
    vscode.commands.registerCommand("opencode.moveView", async () => {
      // `workbench.action.moveFocusedView` reads VS Code's internal `focusedView` context key,
      // which is cleared when focus enters a webview iframe (and by the overflow menu itself).
      // `trackFocus` fires that blur on a 0ms timer, so even setting the key right before the
      // command is racy. The non-focused variant passes the view id explicitly to the
      // destination picker and never errors on a missing focus; it preselects our view when
      // the key happens to be set.
      await vscode.commands.executeCommand("setContext", "focusedView", ChatViewProvider.viewId);
      await vscode.commands.executeCommand("workbench.action.moveView");
    }),
    vscode.commands.registerCommand("opencode.showLogs", () => output.show(true)),
    vscode.commands.registerCommand("opencode.setServerPassword", () => chat.setPassword()),
    // Reset only the registry would leave the controller holding a disposed handle and an SSE
    // stream reconnecting to a dead port; tear down the whole connection through the controller.
    vscode.commands.registerCommand("opencode.stopServer", () => chat.stopServer()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("opencode.executablePath") ||
        e.affectsConfiguration("opencode.endpoint") ||
        e.affectsConfiguration("opencode.startupTimeout") ||
        e.affectsConfiguration("opencode.autoRestart")
      ) {
        void chat.resetServers();
      }
    }),
  );

  // Keep account access visible even when the Secondary Side Bar is closed.
  const status = vscode.window.createStatusBarItem("opencode.status", vscode.StatusBarAlignment.Right, 100);
  status.name = vscode.l10n.t("OpenCode account");
  status.text = "$(comment-discussion)";
  let authLogins: vscode.QuickPickItem[] | undefined;
  const statusDescriptions: Record<ExecutionStatus, string> = {
    idle: vscode.l10n.t("Idle"),
    running: vscode.l10n.t("Generating a response — click to stop"),
    needsInput: vscode.l10n.t("Waiting for your approval or answer — click to open the chat"),
    succeeded: vscode.l10n.t("Response complete — click to open the chat"),
    failed: vscode.l10n.t("Response failed — click to open the chat"),
    interrupted: vscode.l10n.t("Response interrupted — click to open the chat"),
  };
  const updateStatusTooltip = () => {
    if (!vscode.workspace.isTrusted) {
      status.tooltip = vscode.l10n.t("Trust this workspace to use OpenCode");
      return;
    }
    const loginHint =
      authLogins === undefined
        ? vscode.l10n.t("Click to view OpenCode login information")
        : authLogins.length
          ? vscode.l10n.t(
              "OpenCode logins: {0}\nClick to manage logins",
              [...new Set(authLogins.map((login) => [login.label, login.description, login.detail].filter(Boolean).join(" —")))].join(", "),
            )
          : vscode.l10n.t("No saved OpenCode login. Click to sign in");
    status.tooltip = executionStatus === "idle" ? loginHint : `${statusDescriptions[executionStatus]}\n${loginHint}`;
  };
  updateStatusTooltip();
  status.command = "opencode.account";
  const executionIcons: Record<ExecutionStatus, string> = {
    idle: "$(comment-discussion)",
    running: "$(sync~spin)",
    needsInput: "$(question)",
    succeeded: "$(check)",
    failed: "$(alert)",
    interrupted: "$(stop)",
  };
  status.text = executionIcons.idle;
  context.subscriptions.push(
    status,
    chat.onDidChangeExecution((state) => {
      status.text = executionIcons[state.status];
      executionStatus = state.status;
      status.command = state.status === "running" ? "opencode.stopTurn" : state.status === "idle" ? "opencode.account" : "opencode.focus";
      status.color = state.status === "needsInput" ? new vscode.ThemeColor("charts.yellow") : undefined;
      updateStatusTooltip();
    }),
  );
  status.show();
  if (vscode.workspace.isTrusted)
    void readAuthLogins().then(
      (logins) => {
        authLogins = logins;
        updateStatusTooltip();
      },
      (err: unknown) => {
        authLogins = undefined;
        output.error(`[auth] failed to read OpenCode logins: ${String(err)}`);
        status.tooltip = vscode.l10n.t("Could not load OpenCode login information. Click to retry");
      },
    );

  const REVEALED_KEY = "opencode.revealedOnce";
  if (!context.globalState.get<boolean>(REVEALED_KEY)) {
    void context.globalState.update(REVEALED_KEY, true);
    void focusView();
  }

  return { controller: chat };
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  await registry?.dispose();
  controller = undefined;
  registry = undefined;
}
