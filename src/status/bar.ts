import * as vscode from "vscode";
import type { CredentialSummary } from "../shared/api";
import { statusTooltip, type StatusTooltipData } from "./tooltip";

/** The one OpenCode status bar item: a fixed label and a hover listing the connected accounts. */
export interface OpenCodeStatusBar {
  readonly item: vscode.StatusBarItem;
  setCredentials(credentials: CredentialSummary[]): void;
  clearCredentials(): void;
  refresh(): void;
  loadCredentials(): Promise<void>;
}

export function createStatusBar(logError: (line: string) => void, readCredentials: () => Promise<CredentialSummary[]>): OpenCodeStatusBar {
  const item = vscode.window.createStatusBarItem("opencode.status", vscode.StatusBarAlignment.Right, 100);
  item.name = vscode.l10n.t("OpenCode account");
  item.text = "$(account) OpenCode";
  let credentials: CredentialSummary[] | undefined;
  let loadFailed = false;

  const t = (message: string, ...args: (string | number)[]): string => vscode.l10n.t(message, ...args);

  const render = () => {
    const data: StatusTooltipData = { trusted: vscode.workspace.isTrusted, loadFailed, credentials };
    const tooltip = new vscode.MarkdownString(statusTooltip(data, t));
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    // The command gives the item its hover background and lets a click pin the same hover open.
    item.command = "opencode.status.pin";
    item.show();
  };

  render();

  return {
    item,
    setCredentials(next) {
      credentials = next;
      loadFailed = false;
      render();
    },
    clearCredentials() {
      credentials = undefined;
      render();
    },
    refresh: render,
    async loadCredentials() {
      if (!vscode.workspace.isTrusted) return;
      try {
        credentials = await readCredentials();
        loadFailed = false;
      } catch (err) {
        credentials = undefined;
        loadFailed = true;
        logError(`[auth] failed to read OpenCode credentials: ${String(err)}`);
      }
      render();
    },
  };
}
