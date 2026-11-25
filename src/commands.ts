import * as vscode from "vscode";
import { type AuthMenuItem, type AuthQuickPickItem, toAuthItems } from "./auth/logins";
import { type ChatController, type SessionSearchResult } from "./chat/controller";
import { ChatViewProvider } from "./chat/viewProvider";
import type { ConnectController } from "./connect/controller";
import type { AccountStatus } from "./status/account";

export interface CommandDependencies {
  chat: ChatController;
  account: AccountStatus;
  connect: ConnectController;
  output: vscode.OutputChannel;
  logError(line: string): void;
}

/** Registers every contributed command plus the config listener that recreates servers. */
export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { chat, account, connect, output, logError } = deps;
  const focusView = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);

  return [
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
    // Bound to the status bar while a turn is running, so the spinner itself is actionable.
    vscode.commands.registerCommand("opencode.stopTurn", () => void chat.receive({ type: "abort" })),
    vscode.commands.registerCommand("opencode.openChatInEditor", () => chat.openChatInEditor()),
    vscode.commands.registerCommand("opencode.account", async () => {
      let logins: AuthQuickPickItem[];
      try {
        logins = toAuthItems(await chat.credentials());
      } catch (err) {
        logError(`[auth] failed to read OpenCode logins: ${String(err)}`);
        account.clearLogins();
        const action = await vscode.window.showErrorMessage(
          vscode.l10n.t("Could not load OpenCode login information. Check the extension settings."),
          vscode.l10n.t("Open settings"),
        );
        if (action) await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:mattiamalonni.chat-for-opencode");
        return;
      }

      account.setLogins(logins);
      const items: AuthMenuItem[] = logins.map((login) => ({ ...login }));
      if (items.length) items.push({ label: vscode.l10n.t("Actions"), kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: vscode.l10n.t("Sign in or add an OpenCode login"),
        description: vscode.l10n.t("Open the provider sign-in panel"),
        command: "login",
      });
      const selection = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("OpenCode login"),
        placeHolder: logins.length ? vscode.l10n.t("Saved OpenCode logins") : vscode.l10n.t("No saved OpenCode login found"),
      });
      if (selection?.command === "login") connect.open();
    }),
    vscode.commands.registerCommand("opencode.connect", () => connect.open()),
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
    // Reset only the registry would leave the controller holding a disposed handle and a live
    // event subscription; tear down the whole connection through the controller.
    vscode.commands.registerCommand("opencode.stopServer", () => chat.stopServer()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencode.endpoint")) {
        void chat.resetServers();
      }
    }),
  ];
}
