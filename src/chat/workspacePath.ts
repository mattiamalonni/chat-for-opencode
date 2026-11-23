import * as path from "node:path";
import * as vscode from "vscode";
import { isWithinDirectory } from "./tempAttachments";
import { isWithinDirectoryReal } from "./pathSafety";

/**
 * True when a path really lives in any folder the user opened, after resolving symlinks.
 *
 * Shared by the host's file/link opening and by DiffService: both consume untrusted paths from
 * model output, so they must apply the exact same containment rule.
 */
export async function isWithinWorkspace(file: string): Promise<boolean> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isWithinDirectory(file, folder.uri.fsPath) && (await isWithinDirectoryReal(file, folder.uri.fsPath))) return true;
  }
  return false;
}

/** Resolves a chat-supplied path inside a folder, or returns nothing when it escapes it. */
export async function resolveWithinWorkspace(root: vscode.Uri, target: string): Promise<vscode.Uri | undefined> {
  const uri = path.isAbsolute(target) ? vscode.Uri.file(target) : vscode.Uri.joinPath(root, target);
  return (await isWithinWorkspace(uri.fsPath)) ? uri : undefined;
}
