import * as vscode from "vscode";
import { readAuthLogins } from "../auth/logins";
import type { ExecutionState, ExecutionStatus } from "../chat/executionState";

/** The account status item: always visible, even when the Secondary Side Bar is closed. */
export interface AccountStatus {
  readonly item: vscode.StatusBarItem;
  setExecution(state: ExecutionState): void;
  setLogins(logins: vscode.QuickPickItem[]): void;
  clearLogins(): void;
  refreshTooltip(): void;
  loadLogins(): Promise<void>;
}

export function createAccountStatus(logError: (line: string) => void): AccountStatus {
  const item = vscode.window.createStatusBarItem("opencode.status", vscode.StatusBarAlignment.Right, 100);
  item.name = vscode.l10n.t("OpenCode account");
  item.text = "$(comment-discussion)";
  let authLogins: vscode.QuickPickItem[] | undefined;
  // Only the tooltip reads it now; the icon itself comes straight from the execution event.
  let executionStatus: ExecutionStatus = "idle";
  const statusDescriptions: Record<ExecutionStatus, string> = {
    idle: vscode.l10n.t("Idle"),
    running: vscode.l10n.t("Generating a response — click to stop"),
    needsInput: vscode.l10n.t("Waiting for your approval or answer — click to open the chat"),
    succeeded: vscode.l10n.t("Response complete — click to open the chat"),
    failed: vscode.l10n.t("Response failed — click to open the chat"),
    interrupted: vscode.l10n.t("Response interrupted — click to open the chat"),
  };
  const refreshTooltip = () => {
    if (!vscode.workspace.isTrusted) {
      item.tooltip = vscode.l10n.t("Trust this workspace to use OpenCode");
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
    item.tooltip = executionStatus === "idle" ? loginHint : `${statusDescriptions[executionStatus]}\n${loginHint}`;
  };
  refreshTooltip();
  item.command = "opencode.account";
  const executionIcons: Record<ExecutionStatus, string> = {
    idle: "$(comment-discussion)",
    running: "$(sync~spin)",
    needsInput: "$(question)",
    succeeded: "$(check)",
    failed: "$(alert)",
    interrupted: "$(stop)",
  };
  item.text = executionIcons.idle;
  item.show();

  return {
    item,
    setExecution(state) {
      item.text = executionIcons[state.status];
      executionStatus = state.status;
      item.command =
        state.status === "running" ? "opencode.stopTurn" : state.status === "idle" ? "opencode.account" : "opencode.chatView.focus";
      item.color = state.status === "needsInput" ? new vscode.ThemeColor("charts.yellow") : undefined;
      refreshTooltip();
    },
    setLogins(logins) {
      authLogins = logins;
      refreshTooltip();
    },
    clearLogins() {
      authLogins = undefined;
      refreshTooltip();
    },
    refreshTooltip,
    async loadLogins() {
      if (!vscode.workspace.isTrusted) return;
      try {
        authLogins = await readAuthLogins();
        refreshTooltip();
      } catch (err) {
        authLogins = undefined;
        logError(`[auth] failed to read OpenCode logins: ${String(err)}`);
        item.tooltip = vscode.l10n.t("Could not load OpenCode login information. Click to retry");
      }
    },
  };
}
