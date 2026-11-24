import * as vscode from "vscode";
import type { ActionId, Attachment, ContextItem, HostMessage } from "../../shared/protocol";
import type { ControllerState } from "./controllerState";
import { PASSWORD_KEY } from "../storageKeys";
import { normalizeEndpoint } from "../../server/endpoint";

/** User-facing setup actions reachable from error cards and command palette. */
export interface ServerActionDeps {
  state: ControllerState;
  secrets: vscode.SecretStorage;
  output: vscode.LogOutputChannel;
  reconnect(): Promise<void>;
  openConnect(): void;
  resetServers(): Promise<void>;
  newSession(): Promise<void>;
  send(text: string, attachments: Attachment[], context: ContextItem[], delivery?: "steer" | "queue"): Promise<boolean>;
  saveDraft(sessionId: string | undefined, text: string): Promise<void>;
  post(msg: HostMessage): void;
}

export class ChatServerActions {
  constructor(private readonly d: ServerActionDeps) {}

  async setPassword(): Promise<void> {
    const d = this.d;
    // Use the same folder scope as ServerRegistry.get(), otherwise a per-folder endpoint in a
    // multi-root workspace is invisible here (and the secret would be stored under the wrong key).
    const endpoint = normalizeEndpoint(
      vscode.workspace.getConfiguration("opencode", d.state.folder?.uri).get<string>("endpoint", "").trim(),
    ).baseUrl;
    if (!endpoint) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "A password is only needed for an external server (setting opencode.endpoint). The managed server uses a random password automatically.",
        ),
      );
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Password for the OpenCode server at {0}", endpoint),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    if (value) await d.secrets.store(PASSWORD_KEY(endpoint), value);
    else await d.secrets.delete(PASSWORD_KEY(endpoint));
    await d.resetServers();
  }

  /**
   * First-run help. A bare docs link used to be a dead end: now the command is visible and
   * copyable, Windows users get platform-specific instructions, and the retry stays in the flow.
   */
  private async install(): Promise<void> {
    const isWindows = process.platform === "win32";
    const command = "curl -fsSL https://opencode.ai/v2/install | bash";
    const copy = vscode.l10n.t("Copy install command");
    const docs = vscode.l10n.t("Open install instructions");
    const retry = vscode.l10n.t("Retry connection");
    const message = isWindows
      ? vscode.l10n.t(
          "OpenCode is not installed or is not on PATH. Follow the Windows install instructions (PowerShell or WSL), then retry.",
        )
      : vscode.l10n.t("OpenCode is not installed or is not on PATH. Install it, then retry.\n\n{0}", command);
    const choice = await vscode.window.showInformationMessage(message, { modal: true }, ...(isWindows ? [] : [copy]), docs, retry);
    if (choice === copy) await vscode.env.clipboard.writeText(command);
    else if (choice === docs) await vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai/docs/#installation"));
    else if (choice === retry) await this.d.reconnect();
  }

  /** Sign-in is a prerequisite, not a side quest: open the dedicated provider panel. */
  private async login(): Promise<void> {
    this.d.openConnect();
  }

  async run(id: ActionId): Promise<void> {
    const d = this.d;
    switch (id) {
      case "reconnect":
        return d.reconnect();
      case "showLogs":
        d.output.show(true);
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:mattiamalonni.chat-for-opencode");
        return;
      case "install":
        return this.install();
      case "login":
        return this.login();
      case "setPassword":
        return this.setPassword();
      case "openFolder":
        await vscode.commands.executeCommand("vscode.openFolder");
        return;
      case "trustWorkspace":
        // `workspace.requestWorkspaceTrust()` is not in the 1.99 API; the built-in command opens
        // the same Workspace Trust editor with the current folder selected.
        await vscode.commands.executeCommand("workbench.trust.manage");
        return;
      case "newSession":
        return d.newSession();
      case "retry": {
        const failed = d.state.failedPrompt;
        if (!failed) return;
        if (await d.send(failed.text, failed.attachments, failed.context, failed.delivery)) {
          // The restored text is no longer needed: clear it from both the composer and storage.
          if (failed.sessionId) await d.saveDraft(failed.sessionId, "").catch(() => undefined);
          d.post({ type: "draftRestored", sessionId: failed.sessionId, text: "", force: true });
        }
        return;
      }
    }
  }
}
