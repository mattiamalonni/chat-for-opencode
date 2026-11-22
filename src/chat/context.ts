import * as path from "node:path";
import * as vscode from "vscode";
import type { Attachment, ContextItem } from "../shared/protocol";

export function fileUriWithRange(uri: vscode.Uri, start?: number, end?: number): string {
  const base = uri.with({ query: "", fragment: "" }).toString();
  return start !== undefined && end !== undefined ? `${base}?start=${start}&end=${end}` : base;
}

/** Whole-file attachment, used by the editor title action and other file-level commands. */
export function fileAttachment(uri: vscode.Uri): Attachment | undefined {
  if (uri.scheme !== "file") return undefined;
  const name = path.basename(uri.fsPath);
  return { uri: fileUriWithRange(uri), name, kind: "file", detail: name };
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

/**
 * Collects the glob patterns from VS Code's `search.exclude` / `files.exclude` settings. Each setting is
 * a map of glob -> enabled flag. Only enabled, non-empty string globs are kept, duplicates are removed,
 * and malformed values are ignored. Kept pure so it can be tested without a real VS Code host.
 */
export function excludeGlobs(...sources: unknown[]): string[] {
  const globs = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) globs.add(value);
  };
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const value of source) add(value);
    } else if (source && typeof source === "object") {
      for (const [glob, enabled] of Object.entries(source)) {
        if (enabled === true) add(glob);
      }
    }
  }
  return [...globs];
}

/** Converts a VS Code glob into a regex; a match on a directory also matches its descendants. */
function excludeToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` matches zero or more path segments.
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${re}(?:/.*)?$`);
}

/** `findFiles` takes a single glob, so combine several excludes with brace expansion. */
function asGlobPattern(exclude: readonly string[]): string | undefined {
  if (exclude.length === 0) return undefined;
  return exclude.length === 1 ? exclude[0] : `{${exclude.join(",")}}`;
}

/** True when a folder-relative POSIX path is covered by one of the exclude globs. */
function isExcluded(rel: string, exclude: readonly string[]): boolean {
  const path = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return exclude.some((glob) => excludeToRegExp(glob).test(path));
}

/** Bump when the on-disk cache shape changes; entries written with an older version are stale. */
const FILE_INDEX_CACHE_VERSION = 1;

/** NFC-normalizes, deduplicates and sorts globs so equivalent exclude sets compare equal. */
function normalizedExclude(exclude: readonly string[]): string[] {
  return [...new Set(exclude.map((glob) => glob.normalize("NFC")))].sort();
}

/**
 * Builds the persistable file-index snapshot. Kept pure (no `vscode` usage) so it can be unit
 * tested in a plain Node host. URIs are stored as NFC-normalized strings and deduplicated.
 */
export function serializeFileCache(uris: { toString(): string }[], exclude: string[]): unknown {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const value = uri.toString().normalize("NFC");
    if (!seen.has(value)) {
      seen.add(value);
      files.push(value);
    }
  }
  return { version: FILE_INDEX_CACHE_VERSION, exclude: [...exclude], files };
}

/**
 * Reads a snapshot produced by {@link serializeFileCache}. Returns `undefined` for a missing,
 * malformed, outdated or exclude-mismatched entry so the caller rescans. Malformed file entries
 * are skipped. Kept pure so it can be unit tested in a plain Node host.
 */
export function deserializeFileCache(raw: unknown, expectedExclude: string[]): string[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== FILE_INDEX_CACHE_VERSION) return undefined;
  if (!Array.isArray(record.exclude) || !Array.isArray(record.files)) return undefined;
  const storedExclude = record.exclude.filter((glob): glob is string => typeof glob === "string");
  if (storedExclude.length !== record.exclude.length) return undefined;
  const cachedExclude = normalizedExclude(storedExclude);
  const wantedExclude = normalizedExclude(expectedExclude);
  if (cachedExclude.length !== wantedExclude.length || cachedExclude.some((glob, i) => glob !== wantedExclude[i])) {
    return undefined;
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of record.files) {
    if (typeof entry !== "string") continue;
    const value = entry.normalize("NFC");
    if (!seen.has(value)) {
      seen.add(value);
      files.push(value);
    }
  }
  return files;
}

/** Cached workspace file list with fuzzy search for `@` mentions. */
export class FileIndex implements vscode.Disposable {
  private files: vscode.Uri[] | undefined;
  private loading: Promise<vscode.Uri[]> | undefined;
  /** Bumped on every invalidation/dispose so a stale in-flight scan cannot commit its result. */
  private generation = 0;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly exclude: string[];
  private readonly storage: vscode.Memento | undefined;
  private readonly cacheKey: string | undefined;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    storage?: vscode.Memento,
  ) {
    const config = vscode.workspace.getConfiguration(undefined, folder.uri);
    this.exclude = excludeGlobs(config.get("search.exclude"), config.get("files.exclude"));
    this.storage = storage;
    // One snapshot per folder: a different workspace must not reuse another folder's file list.
    this.cacheKey = storage ? `opencode.fileIndex:${folder.uri.toString()}` : undefined;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"), false, true, false);
    // `createFileSystemWatcher` has no `exclude` argument, so skip events for excluded paths here.
    const invalidate = (uri: vscode.Uri): void => {
      if (isExcluded(path.relative(this.folder.uri.fsPath, uri.fsPath), this.exclude)) return;
      this.files = undefined;
      // Bumping the generation disqualifies any scan already in flight: even if it resolves later,
      // it will neither restore `files` nor persist its outdated snapshot.
      this.generation++;
      // Drop the persisted snapshot too so a fresh window cannot restore a stale list. Best-effort:
      // a failed write is ignored.
      if (this.storage && this.cacheKey) {
        void Promise.resolve(this.storage.update(this.cacheKey, undefined)).catch(() => {});
      }
    };
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  private async list(): Promise<vscode.Uri[]> {
    if (this.files) return this.files;
    if (!this.loading) {
      const generation = this.generation;
      this.loading = (async (): Promise<vscode.Uri[]> => {
        if (this.storage && this.cacheKey) {
          const cached = deserializeFileCache(this.storage.get(this.cacheKey), this.exclude);
          if (cached) return cached.map((value) => vscode.Uri.parse(value));
        }
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(this.folder, "**/*"),
          asGlobPattern(this.exclude),
          20_000,
        );
        // An invalidation may have happened while `findFiles` was in flight: never persist a
        // snapshot that is already known to be stale.
        if (generation === this.generation && this.storage && this.cacheKey) {
          // Best-effort persistence: a storage failure must never break file search.
          void Promise.resolve(this.storage.update(this.cacheKey, serializeFileCache(files, this.exclude))).catch(() => {});
        }
        return files;
      })().then((files) => {
        this.loading = undefined;
        // Only commit if nothing invalidated the index while the scan was running.
        if (generation === this.generation) this.files = files;
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
    // Invalidate so a scan resolving after disposal cannot commit files or persist a snapshot.
    this.generation++;
    this.files = undefined;
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
