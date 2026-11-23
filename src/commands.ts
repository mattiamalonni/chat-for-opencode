import * as vscode from "vscode";
import { type AuthMenuItem, readAuthLogins } from "./auth/logins";
import { type ChatController, type SessionSearchResult } from "./chat/controller";
import { selectionAttachment } from "./chat/context";
import { ChatViewProvider } from "./chat/viewProvider";
import type { AccountStatus } from "./status/account";

export interface CommandDependencies {
  chat: ChatController;
  account: AccountStatus;
  output: vscode.OutputChannel;
  logError(line: string): void;
}

/** Registers every contributed command plus the config listener that recreates servers. */
export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { chat, account, output, logError } = deps;
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
    vscode.commands.registerCommand("opencode.account", async () => {
      let logins: vscode.QuickPickItem[];
      try {
        logins = await readAuthLogins();
      } catch (err) {
        logError(`[auth] failed to read OpenCode logins: ${String(err)}`);
        account.clearLogins();
        const action = await vscode.window.showErrorMessage(
          vscode.l10n.t("Could not load OpenCode login information. Check the OpenCode installation and executable path."),
          vscode.l10n.t("Open settings"),
        );
        if (action) await vscode.commands.executeCommand("workbench.action.openSettings", "opencode.executablePath");
        return;
      }

      account.setLogins(logins);
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
  ];
}
