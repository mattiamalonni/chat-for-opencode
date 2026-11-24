import type * as vscode from "vscode";
import type { CredentialSummary } from "../shared/api";

/** A saved provider account, projected from the server credential list (never its secret). */
export interface AuthQuickPickItem extends vscode.QuickPickItem {
  id: string;
  integrationID: string;
}

/** Picker rows: real accounts plus the separator and the "sign in" action. */
export type AuthMenuItem = vscode.QuickPickItem & { id?: string; integrationID?: string; command?: "login" };

/**
 * Both the status bar and the Account picker use this projection of `GET /api/credential`, the same
 * source as the Connect panel. Reading the CLI's `auth list --format json` here used to hide every
 * provider except the built-in `opencode` one, so the two views could disagree.
 */
export function toAuthItems(credentials: CredentialSummary[]): AuthQuickPickItem[] {
  return [...credentials]
    .sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label))
    .map((credential) => ({
      id: credential.id,
      integrationID: credential.integrationID,
      label: credential.label,
      description: credential.integrationID,
      detail: `${credential.type}${credential.active ? " · active" : ""}`,
    }));
}
