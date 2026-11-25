/**
 * Minimal hover content for the OpenCode status bar item: just the connected accounts.
 * Kept free of `vscode` so the layout is unit-testable; the caller wraps the returned markdown in a
 * `MarkdownString` with HTML and theme icons enabled. VS Code's markdown renderer allows a small
 * subset of HTML: theme-variable colours, `display:inline-block` and `border-radius` on spans —
 * enough to draw compact, rounded account rows that follow the active theme.
 */
import type { CredentialSummary } from "../shared/api";

export interface StatusTooltipData {
  readonly trusted: boolean;
  readonly loadFailed: boolean;
  readonly credentials: CredentialSummary[] | undefined;
}

type Translate = (message: string, ...args: (string | number)[]) => string;

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function statusTooltip(data: StatusTooltipData, t: Translate): string {
  const lines = [`**<span style="color:var(--vscode-foreground);">$(account) ${t("OpenCode")}</span>**`, "", "---", ""];

  if (!data.trusted) lines.push(`> $(shield) ${t("Trust this workspace to use OpenCode")}`);
  else if (data.loadFailed) lines.push(`> $(alert) ${t("Could not load OpenCode login information")}`);
  else if (!data.credentials?.length) lines.push(`> $(info) ${t("No connected account")}`);
  else {
    const maxLength = Math.max(...data.credentials.map((credential) => credential.label.length));
    for (const credential of data.credentials) {
      const background = credential.active ? "var(--vscode-list-activeSelectionBackground)" : "var(--vscode-list-hoverBackground)";
      const icon = credential.active ? "$(verified)" : "$(account)";
      const name = escape(credential.label);
      const content = credential.active ? `${icon}&nbsp;<strong>${name}</strong>` : `${icon}&nbsp;${name}`;
      // Pad shorter names so the rounded rows end at roughly the same column.
      const padding = "&nbsp;".repeat(Math.max(0, maxLength - credential.label.length));
      lines.push(
        `<span style="background-color:${background};display:inline-block;border-radius:4px;">&nbsp;${content}&nbsp;${padding}</span>`,
        "",
      );
    }
  }

  return lines.join("\n").trimEnd();
}
