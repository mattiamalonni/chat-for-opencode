import * as vscode from "vscode";
import { usageLabel, usageTooltip, usageUpdateFromMessage, type SessionUsage } from "../chat/usageStatus";
import type { HostMessage } from "../shared/protocol";

/** The quiet status item that keeps the running cost visible with the sidebar collapsed. */
export interface UsageStatus {
  readonly item: vscode.StatusBarItem;
  onMessage(msg: HostMessage): void;
  onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void;
}

export function createUsageStatus(): UsageStatus {
  const item = vscode.window.createStatusBarItem("opencode.usage", vscode.StatusBarAlignment.Right, 99);
  item.name = vscode.l10n.t("OpenCode session usage");
  item.command = "opencode.chatView.focus";
  let sessionUsage: SessionUsage | undefined;
  const render = () => {
    const enabled = vscode.workspace.getConfiguration("opencode").get<boolean>("showUsageInStatusBar", true);
    if (!sessionUsage || !enabled || !vscode.workspace.isTrusted) {
      item.hide();
      return;
    }
    item.text = usageLabel(sessionUsage);
    item.tooltip = usageTooltip(sessionUsage, (message) => vscode.l10n.t(message));
    item.show();
  };
  render();

  return {
    item,
    onMessage(msg) {
      const update = usageUpdateFromMessage(msg);
      if (update.kind === "keep") return;
      sessionUsage = update.kind === "set" ? update.usage : undefined;
      render();
    },
    onConfigurationChanged(e) {
      if (e.affectsConfiguration("opencode.showUsageInStatusBar")) render();
    },
  };
}
