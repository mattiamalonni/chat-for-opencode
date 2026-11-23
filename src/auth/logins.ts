import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export type AuthMenuItem = vscode.QuickPickItem & { command?: "login" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAuthLogins(output: string): vscode.QuickPickItem[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("Expected an array from `opencode auth list --format json`.");

  const items: vscode.QuickPickItem[] = [];
  for (const integration of parsed) {
    if (!isRecord(integration) || typeof integration.id !== "string") {
      throw new Error("Unexpected integration format from `opencode auth list --format json`.");
    }
    if (integration.id !== "opencode") continue;
    if (typeof integration.name !== "string" || !Array.isArray(integration.connections)) {
      throw new Error("Unexpected OpenCode login format from `opencode auth list --format json`.");
    }
    for (const connection of integration.connections) {
      if (!isRecord(connection)) throw new Error("Unexpected login format from `opencode auth list --format json`.");
      const description = typeof connection.label === "string" ? connection.label : undefined;
      const detail = [connection.method, connection.type].filter((value): value is string => typeof value === "string").join(" · ");
      items.push({ label: integration.name, description, detail: detail || undefined });
    }
  }
  return items;
}

export async function readAuthLogins(): Promise<vscode.QuickPickItem[]> {
  if (!vscode.workspace.isTrusted) throw new Error("Workspace is not trusted");
  const executable = vscode.workspace.getConfiguration("opencode").get<string>("executablePath", "opencode").trim() || "opencode";
  const { stdout } = await execFileAsync(executable, ["auth", "list", "--format", "json"], { timeout: 10_000 });
  return parseAuthLogins(stdout);
}
