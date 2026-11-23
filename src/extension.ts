import * as path from "node:path";
import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { ChatController, ServerRegistry } from "./chat/controller";
import { DIFF_SCHEME, DiffService } from "./chat/diff";
import { ChatViewProvider } from "./chat/viewProvider";
import { cleanupOrphanServers } from "./server/orphans";
import { createAccountStatus } from "./status/account";
import { createUsageStatus } from "./status/usage";

let registry: ServerRegistry | undefined;
let controller: ChatController | undefined;

export interface ExtensionApi {
  controller: ChatController;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const output = vscode.window.createOutputChannel("OpenCode", { log: true });
  const log = (line: string) => output.info(line);
  const logError = (line: string) => output.error(line);
  const recordsDir = path.join(context.globalStorageUri.fsPath, "servers");
  // A server whose extension host died (VS Code crash) cannot clean up after itself. Reap it
  // before starting any new one, but leave servers owned by other live VS Code windows alone.
  void cleanupOrphanServers(recordsDir, log);
  registry = new ServerRegistry(context.secrets, log, recordsDir);
  const diffs = new DiffService((line) => output.warn(line));
  controller = new ChatController(context, registry, diffs, output);
  const chat = controller;

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  const usage = createUsageStatus();
  const account = createAccountStatus(logError);

  context.subscriptions.push(
    usage.item,
    account.item,
    chat.onDidPost((msg) => usage.onMessage(msg)),
    vscode.workspace.onDidChangeConfiguration((e) => usage.onConfigurationChanged(e)),
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
    ...registerCommands({ chat, account, output, logError }),
    chat.onDidChangeExecution((state) => account.setExecution(state)),
  );

  account.loadLogins();

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
