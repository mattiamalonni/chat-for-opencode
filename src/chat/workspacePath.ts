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
