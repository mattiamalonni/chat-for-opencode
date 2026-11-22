import * as path from "node:path";
import * as vscode from "vscode";
import { evictableKey } from "../shared/diffCache";
import { applyPatch, hunksSides, sidesFromPatch } from "../shared/patch";
import { isWithinDirectory } from "./tempAttachments";
import { isWithinDirectoryReal } from "./pathSafety";

export const DIFF_SCHEME = "opencode-diff";
const MAX_VIRTUAL_DOCS = 200;

/** Serves the read-only "other side" of OpenCode diffs as virtual documents. */
export class DiffService implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;

  constructor(private readonly warn: (message: string) => void = () => undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  private virtual(file: string, label: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: "/" + file.replace(/\\/g, "/").replace(/^\/+/, ""),
      query: `${label}-${++this.counter}`,
    });
    this.contents.set(uri.toString(), content);
    // Keep memory bounded, but never blank a diff tab that is still open.
    if (this.contents.size > MAX_VIRTUAL_DOCS) {
      const open = new Set(vscode.workspace.textDocuments.filter((d) => d.uri.scheme === DIFF_SCHEME).map((d) => d.uri.toString()));
      const victim = evictableKey(this.contents, open);
      if (victim) this.contents.delete(victim);
    }
    return uri;
  }

  private async isWithinWorkspace(file: string): Promise<boolean> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (isWithinDirectory(file, folder.uri.fsPath) && (await isWithinDirectoryReal(file, folder.uri.fsPath))) return true;
    }
    return false;
  }

  /** Resolves an untrusted chat path inside the folder, or refuses it with a log line. */
  private async resolveTarget(root: vscode.Uri, file: string): Promise<vscode.Uri | undefined> {
    const target = path.isAbsolute(file) ? vscode.Uri.file(file) : vscode.Uri.joinPath(root, file);
    // `file` comes from tool metadata produced by the model, i.e. untrusted chat content. Apply the
    // same workspace containment rule as the host's openFile(): no absolute path, `..` escape or
    // crafted tool output may make us read a file outside the folder and show it in a diff.
    // Relative paths are joined to the active folder; absolute paths may point at any folder the
    // user opened. Both are checked after resolving symlinks, so `../` escapes remain blocked.
    if (!(await this.isWithinWorkspace(target.fsPath))) {
      this.warn(`[chat] blocked a diff for a file outside the workspace: ${target.fsPath}`);
      return undefined;
    }
    return target;
  }

  /**
   * Opens a native diff for `patch`.
   * `applied: true`  → the change is already on disk: left = reconstructed original, right = file.
   * `applied: false` → proposed change (permission request): left = file, right = patched preview.
   */
  async open(root: vscode.Uri, file: string, patch: string, applied: boolean): Promise<void> {
    const target = await this.resolveTarget(root, file);
    if (!target) return;
    let current: string | undefined;
    try {
      current = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    } catch {
      current = undefined;
    }
    const name = path.basename(file);
    const fallback = sidesFromPatch(patch);
    let left: vscode.Uri;
    let right: vscode.Uri;

    if (applied) {
      const original = current !== undefined ? applyPatch(current, patch, { reverse: true }) : undefined;
      if (current !== undefined && original !== undefined) {
        left = this.virtual(file, "before", original);
        right = target;
      } else {
        left = this.virtual(file, "before", fallback.before);
        right = this.virtual(file, "after", current ?? fallback.after);
      }
    } else {
      const proposed = applyPatch(current ?? "", patch);
      if (proposed !== undefined) {
        left = current !== undefined ? target : this.virtual(file, "before", "");
        right = this.virtual(file, "proposed", proposed);
      } else {
        left = this.virtual(file, "before", fallback.before);
        right = this.virtual(file, "proposed", fallback.after);
      }
    }
    const title = vscode.l10n.t("{0} (OpenCode {1})", name, applied ? vscode.l10n.t("changes") : vscode.l10n.t("proposed"));
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }

  /** Shows a proposed code-block edit as an unsaved right-hand side of a native diff. */
  async openProposal(target: vscode.Uri, current: string, proposed: string): Promise<void> {
    const file = target.fsPath;
    const name = path.basename(file);
    const left = current.length > 0 ? target : this.virtual(file, "empty", "");
    const right = this.virtual(file, "proposed", proposed);
    const title = vscode.l10n.t("{0} (OpenCode proposal)", name);
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }

  /**
   * Shows all the edits of a turn in a native multi-file diff. Each row compares the real file
   * with its pre-edit content (reconstructed by reversing the patch), so the user gets full-file
   * context and can navigate file by file. The synthetic hunk-only view remains as a fallback for
   * sessions without a workspace or for files whose patch no longer applies.
   */
  async openCombined(files: Array<{ file: string; patch: string }>, root?: vscode.Uri): Promise<void> {
    if (root) {
      // `vscode.changes` expects [resource, original, modified] triples: the first URI identifies
      // the editor tab, the other two are the sides of the diff.
      const changes: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
      for (const { file, patch } of files) {
        if (!patch) continue;
        const target = await this.resolveTarget(root, file);
        if (!target) continue;
        let current: string;
        try {
          current = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
        } catch {
          continue;
        }
        const original = applyPatch(current, patch, { reverse: true });
        if (original === undefined) continue;
        changes.push([target, this.virtual(file, "before", original), target]);
      }
      if (changes.length > 0) {
        try {
          await vscode.commands.executeCommand("vscode.changes", vscode.l10n.t("OpenCode changes"), changes);
          return;
        } catch (err) {
          this.warn(`[chat] native multi-file diff unavailable, using the patch view: ${String(err)}`);
        }
      }
    }
    const { before, after } = hunksSides(files);
    if (!before && !after) return;
    const left = this.virtual("changes", "before", before);
    const right = this.virtual("changes", "after", after);
    const title = vscode.l10n.t("OpenCode changes");
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }
}
