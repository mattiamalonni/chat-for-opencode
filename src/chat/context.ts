import * as path from "node:path";
import * as vscode from "vscode";
import type { Attachment, ContextItem } from "../shared/protocol";

export function fileUriWithRange(uri: vscode.Uri, start?: number, end?: number): string {
  const base = uri.with({ query: "", fragment: "" }).toString();
  return start !== undefined && end !== undefined ? `${base}?start=${start}&end=${end}` : base;
}

export function selectionAttachment(editor: vscode.TextEditor): Attachment | undefined {
  const sel = editor.selection;
  if (sel.isEmpty || editor.document.uri.scheme !== "file") return undefined;
  const start = sel.start.line + 1;
  // A selection ending at column 0 doesn't include that line.
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const name = path.basename(editor.document.uri.fsPath);
  return {
    uri: fileUriWithRange(editor.document.uri, start, end),
    name,
    kind: "selection",
    detail: start === end ? `${name}:${start}` : `${name}:${start}-${end}`,
  };
}

/** Tracks the active editor and selection and reports them as removable context chips. */
export class ContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onChange: (items: ContextItem[]) => void) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("opencode.autoContext")) this.schedule();
      }),
    );
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(this.current()), 150);
  }

  current(): ContextItem[] {
    if (!vscode.workspace.getConfiguration("opencode").get<boolean>("autoContext", true)) return [];
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return [];
    const uri = editor.document.uri;
    const rel = vscode.workspace.asRelativePath(uri, false);
    const items: ContextItem[] = [
      { id: fileUriWithRange(uri), kind: "file", uri: fileUriWithRange(uri), label: path.basename(uri.fsPath), detail: rel },
    ];
    const sel = selectionAttachment(editor);
    if (sel) items.push({ id: sel.uri, kind: "selection", uri: sel.uri, label: sel.detail ?? sel.name, detail: rel });
    return items;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

/** Cached workspace file list with fuzzy search for `@` mentions. */
export class FileIndex implements vscode.Disposable {
  private files: vscode.Uri[] | undefined;
  private loading: Promise<vscode.Uri[]> | undefined;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly folder: vscode.WorkspaceFolder) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"), false, true, false);
    this.watcher.onDidCreate(() => (this.files = undefined));
    this.watcher.onDidDelete(() => (this.files = undefined));
  }

  private async list(): Promise<vscode.Uri[]> {
    if (this.files) return this.files;
    if (!this.loading) {
      this.loading = Promise.resolve(
        vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, "**/*"), undefined, 20_000),
      ).then((files) => {
        this.files = files;
        this.loading = undefined;
        return files;
      });
    }
    return this.loading;
  }

  async search(query: string, limit = 30): Promise<Attachment[]> {
    const files = await this.list();
    const scored: { uri: vscode.Uri; rel: string; score: number }[] = [];
    for (const uri of files) {
      const rel = path.relative(this.folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
      const score = fuzzyScore(query, rel);
      if (score > 0) scored.push({ uri, rel, score });
    }
    scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
    return scored.slice(0, limit).map((s) => ({
      uri: s.uri.toString(),
      name: path.basename(s.rel),
      kind: "file" as const,
      detail: s.rel,
    }));
  }

  dispose(): void {
    this.watcher.dispose();
  }
}

/** Subsequence match; rewards basename hits, contiguous runs and prefix matches. 0 = no match. */
export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const base = c.slice(c.lastIndexOf("/") + 1);
  let score = 0;
  if (base.startsWith(q)) score += 100;
  else if (base.includes(q)) score += 60;
  else if (c.includes(q)) score += 30;
  let qi = 0;
  let run = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      qi++;
      run++;
      score += 1 + run;
    } else {
      run = 0;
    }
  }
  return qi === q.length ? score : 0;
}
