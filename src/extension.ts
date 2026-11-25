import * as vscode from "vscode";
import { registerCommands } from "./commands";
import { ChatController, ServerRegistry } from "./chat/controller";
import { DIFF_SCHEME, DiffService } from "./chat/diff";
import { ChatViewProvider } from "./chat/viewProvider";
import { createHost, makeNetworkApi } from "./sdk/bridge";
import { setSdkBridge } from "./sdk/loader";
import { ConnectController } from "./connect/controller";
import { createStatusBar } from "./status/bar";

let registry: ServerRegistry | undefined;
let controller: ChatController | undefined;

export interface ExtensionApi {
  controller: ChatController;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  if (!process.env.OC_SDK_BRIDGE_MODULE) setSdkBridge({ createHost, makeNetworkApi });
  const output = vscode.window.createOutputChannel("OpenCode", { log: true });
  const log = (line: string) => output.info(line);
  const logError = (line: string) => output.error(line);
  // OpenCode runs in this process through the bundled SDK; there is no child server process.
  registry = new ServerRegistry(context.secrets, log);
  const diffs = new DiffService((line) => output.warn(line));
  controller = new ChatController(context, registry, diffs, output);
  const chat = controller;

  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  const statusBar = createStatusBar(logError, () => chat.credentials());
  const connect = new ConnectController(context.extensionUri, {
    getClient: () => chat.apiClient,
    ensureClient: async () => {
      await chat.connect();
      return chat.apiClient;
    },
    getFolder: () => chat.folderUri,
    onChanged: async () => {
      await chat.refreshCatalog();
      statusBar.loadCredentials();
    },
    output,
  });

  context.subscriptions.push(
    statusBar.item,
    chat.onDidPost((msg) => {
      // The account hover uses the same server API as the Connect panel. Refresh it once the chat
      // has a live client, without creating a host just to populate a status bar.
      if (msg.type === "connection" && msg.status === "connected") void statusBar.loadCredentials();
    }),
    output,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, new ChatViewProvider(context.extensionUri, chat)),
    vscode.window.registerWebviewPanelSerializer("opencode.chat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        chat.attachPanel(panel);
      },
    }),
    vscode.window.registerWebviewPanelSerializer("opencode.connect", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        connect.attachPanel(panel);
      },
    }),
    connect,
    // 1.99 exposes only the "granted" event: untrusting a workspace requires a window reload, so
    // there is nothing to react to there. Reconnect/prompt paths re-check `isTrusted` themselves.
    vscode.workspace.onDidGrantWorkspaceTrust(() => void chat.onWorkspaceTrustChanged(true)),
    ...registerCommands({ chat, statusBar, connect, output, logError }),
  );

  // `loadCredentials()` runs on the first "connected" event above; at activation there is no client yet.

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
