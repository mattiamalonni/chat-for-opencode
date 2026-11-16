import * as path from "node:path";
import * as vscode from "vscode";
import { ChatController, ServerRegistry } from "./chat/controller";
import { DIFF_SCHEME, DiffService } from "./chat/diff";
import { ChatViewProvider } from "./chat/viewProvider";

let registry: ServerRegistry | undefined;
let controller: ChatController | undefined;

export interface ExtensionApi {
  controller: ChatController;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const output = vscode.window.createOutputChannel("OpenCode", { log: true });
  const log = (line: string) => output.info(line);
  registry = new ServerRegistry(context.secrets, log);
  const diffs = new DiffService();
  controller = new ChatController(context, registry, diffs, output);
  const chat = controller;

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);

  context.subscriptions.push(
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, new ChatViewProvider(context.extensionUri, chat)),
    vscode.commands.registerCommand("opencode.newSession", async () => {
      await focusView();
      await chat.newSession();
    }),
    vscode.commands.registerCommand("opencode.reconnect", () => chat.reconnect()),
    vscode.commands.registerCommand("opencode.focus", async () => {
      await focusView();
      chat.post({ type: "focusInput" });
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

  return { controller: chat };
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  await registry?.dispose();
  controller = undefined;
  registry = undefined;
}
