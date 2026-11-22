import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { ChatController, ServerRegistry, type ExecutionStatus, type SessionSearchResult } from "./chat/controller";
import { DIFF_SCHEME, DiffService } from "./chat/diff";
import { selectionAttachment } from "./chat/context";
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

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  const readAuthLogins = async () => {
    if (!vscode.workspace.isTrusted) throw new Error("Workspace is not trusted");
    const executable = vscode.workspace.getConfiguration("opencode").get<string>("executablePath", "opencode").trim() || "opencode";
    const { stdout } = await execFileAsync(executable, ["auth", "list", "--format", "json"], { timeout: 10_000 });
    return parseAuthLogins(stdout);
  };

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, new ChatViewProvider(context.extensionUri, chat)),
    vscode.window.registerWebviewPanelSerializer("opencode.chat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        chat.attachPanel(panel);
      },
    }),
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
    vscode.commands.registerCommand("opencode.openConfigFile", () => chat.openConfigFile()),
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
    vscode.commands.registerCommand("opencode.focus", async () => {
      await focusView();
      chat.post({ type: "focusInput" });
    }),
    vscode.commands.registerCommand("opencode.openChatInEditor", () => chat.openChatInEditor()),
    vscode.commands.registerCommand("opencode.ask", async () => {
      const text = await vscode.window.showInputBox({
        title: vscode.l10n.t("Ask OpenCode"),
        prompt: vscode.l10n.t("Send a prompt without leaving your editor"),
        placeHolder: vscode.l10n.t("Describe what you want OpenCode to do…"),
      });
      if (!text?.trim()) return;
      await focusView();
      await chat.ask(text);
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
  const updateStatusTooltip = () => {
    if (!vscode.workspace.isTrusted) {
      status.tooltip = vscode.l10n.t("Trust this workspace to use OpenCode");
      return;
    }
    status.tooltip =
      authLogins === undefined
        ? vscode.l10n.t("Click to view OpenCode login information")
        : authLogins.length
          ? vscode.l10n.t(
              "OpenCode logins: {0}\nClick to manage logins",
              [...new Set(authLogins.map((login) => [login.label, login.description, login.detail].filter(Boolean).join(" —")))].join(", "),
            )
          : vscode.l10n.t("No saved OpenCode login. Click to sign in");
  };
  updateStatusTooltip();
  status.command = "opencode.account";
  const executionIcons: Record<ExecutionStatus, string> = {
    idle: "$(comment-discussion)",
    running: "$(sync~spin)",
    succeeded: "$(check)",
    failed: "$(alert)",
    interrupted: "$(stop)",
  };
  status.text = executionIcons.idle;
  context.subscriptions.push(
    status,
    chat.onDidChangeExecution((state) => {
      status.text = executionIcons[state.status];
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
