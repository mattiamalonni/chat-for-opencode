import * as path from "node:path";
import * as vscode from "vscode";
import { evictableKey } from "../shared/diffCache";
import { applyPatch, hunksSides, sidesFromPatch } from "../shared/patch";

export const DIFF_SCHEME = "opencode-diff";
const MAX_VIRTUAL_DOCS = 200;

/** Serves the read-only "other side" of OpenCode diffs as virtual documents. */
export class DiffService implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;

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
      const open = new Set(
        vscode.workspace.textDocuments.filter((d) => d.uri.scheme === DIFF_SCHEME).map((d) => d.uri.toString()),
      );
      const victim = evictableKey(this.contents, open);
      if (victim) this.contents.delete(victim);
    }
    return uri;
  }

  /**
   * Opens a native diff for `patch`.
   * `applied: true`  → the change is already on disk: left = reconstructed original, right = file.
   * `applied: false` → proposed change (permission request): left = file, right = patched preview.
   */
  async open(root: vscode.Uri, file: string, patch: string, applied: boolean): Promise<void> {
    const target = path.isAbsolute(file) ? vscode.Uri.file(file) : vscode.Uri.joinPath(root, file);
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

  /**
   * Shows all the edits of a turn in one native VS Code diff editor. Only the changed hunks (with
   * their context) are used for the two sides, so the view contains the differences, not the whole
   * files. Both sides are virtual documents: nothing is read from or written to disk.
   */
  async openCombined(files: Array<{ file: string; patch: string }>): Promise<void> {
    const { before, after } = hunksSides(files);
    if (!before && !after) return;
    const left = this.virtual("changes", "before", before);
    const right = this.virtual("changes", "after", after);
    const title = vscode.l10n.t("OpenCode changes");
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }
}
