import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { ChatController, ServerRegistry } from "./chat/controller";
import { DIFF_SCHEME, DiffService } from "./chat/diff";
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
      const detail = [connection.method, connection.type]
        .filter((value): value is string => typeof value === "string")
        .join(" · ");
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
  const diffs = new DiffService();
  controller = new ChatController(context, registry, diffs, output);
  const chat = controller;

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  const readAuthLogins = async () => {
    const executable = vscode.workspace.getConfiguration("opencode").get<string>("executablePath", "opencode").trim() || "opencode";
    const { stdout } = await execFileAsync(executable, ["auth", "list", "--format", "json"], { timeout: 10_000 });
    return parseAuthLogins(stdout);
  };

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, new ChatViewProvider(context.extensionUri, chat)),
    vscode.commands.registerCommand("opencode.newSession", async () => {
      await focusView();
      await chat.newSession();
    }),
    vscode.commands.registerCommand("opencode.reconnect", () => chat.reconnect()),
    vscode.commands.registerCommand("opencode.compact", () => chat.compact()),
    vscode.commands.registerCommand("opencode.focus", async () => {
      await focusView();
      chat.post({ type: "focusInput" });
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
        placeHolder: logins.length
          ? vscode.l10n.t("Saved OpenCode logins")
          : vscode.l10n.t("No saved OpenCode login found"),
      });
      if (selection?.command === "login") await chat.runAction("login");
    }),
    vscode.commands.registerCommand("opencode.addSelectionToChat", async () => {
      await focusView();
      if (!chat.addSelection(vscode.window.activeTextEditor)) {
        void vscode.window.showInformationMessage(vscode.l10n.t("Select some text in a file first."));
      }
    }),
    vscode.commands.registerCommand("opencode.addFileToChat", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== "file") return;
      await focusView();
      chat.addAttachment({ uri: target.toString(), name: path.basename(target.fsPath), kind: "file", detail: vscode.workspace.asRelativePath(target) });
    }),
    vscode.commands.registerCommand("opencode.moveView", async () => {
      await focusView();
      // Built-in "View: Move View" quick pick (primary/secondary side bar, panel).
      await vscode.commands.executeCommand("workbench.action.moveFocusedView");
    }),
    vscode.commands.registerCommand("opencode.showLogs", () => output.show(true)),
    vscode.commands.registerCommand("opencode.setServerPassword", () => chat.setPassword()),
    vscode.commands.registerCommand("opencode.stopServer", () => registry?.reset()),
    vscode.commands.registerCommand("opencode.showChanges", async () => {
      await focusView();
      await chat.refreshChanges();
    }),
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
    status.tooltip = authLogins === undefined
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
  status.show();
  context.subscriptions.push(status);
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
