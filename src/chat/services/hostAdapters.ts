/**
 * VS Code implementations of the hooks that keep ApplyCodeService, PromptLibraryService and
 * FileIconThemeService testable without an extension host. They used to be inline closures in the
 * ChatController constructor; the controller now only says where the folder and logs come from.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { ApplyCodeService } from "../applyCode";
import type { DiffService } from "../diff";
import { FileIconThemeService, type LanguageContribution } from "../fileIconTheme";
import { workingDiff } from "../gitDiff";
import { formatPromptDiagnostics, formatPromptDiff } from "../promptContext";
import { PromptLibraryService } from "../promptLibrary";

type FolderGetter = () => vscode.WorkspaceFolder | undefined;

async function readUri(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Replaces the whole document (or creates the file) through an undoable WorkspaceEdit. */
async function writeUri(uri: vscode.Uri, content: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  let document: vscode.TextDocument | undefined;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    document = undefined;
  }
  if (document) {
    edit.set(uri, [new vscode.TextEdit(new vscode.Range(0, 0, document.lineCount, 0), content)]);
  } else {
    edit.createFile(uri);
    edit.insert(uri, new vscode.Position(0, 0), content);
  }
  await vscode.workspace.applyEdit(edit);
}

export interface ApplyCodeAdapterDeps {
  getFolder: FolderGetter;
  /** Resolves an untrusted path inside the workspace, with the real-path escape check. */
  resolve(targetPath: string): Promise<{ uri: vscode.Uri; path: string } | undefined>;
  diffs: DiffService;
  warn(message: string): void;
}

export function createApplyCodeService(d: ApplyCodeAdapterDeps): ApplyCodeService<vscode.Uri> {
  return new ApplyCodeService<vscode.Uri>({
    t: (message, ...args) => vscode.l10n.t(message, ...args),
    folder: () => d.getFolder()?.uri.fsPath,
    activePath: () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined;
    },
    resolve: (targetPath) => d.resolve(targetPath),
    pickPath: async (candidates) => {
      const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 200);
      const items = [...new Set([...candidates, ...files.map((uri) => vscode.workspace.asRelativePath(uri, false))])];
      return vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t("Choose a file to apply this code to") });
    },
    read: readUri,
    preview: (uri, current, proposed) => d.diffs.openProposal(uri, current, proposed),
    confirm: async () => {
      const accept = vscode.l10n.t("Accept");
      const choice = await vscode.window.showInformationMessage(vscode.l10n.t("Apply this change?"), accept, vscode.l10n.t("Reject"));
      return choice === accept;
    },
    write: writeUri,
    warn: (message) => d.warn(message),
    info: (message) => void vscode.window.showInformationMessage(message),
  });
}

export interface PromptLibraryAdapterDeps {
  getFolder: FolderGetter;
  trustBlocked(): boolean;
}

export function createPromptLibraryService(d: PromptLibraryAdapterDeps): PromptLibraryService {
  return new PromptLibraryService({
    t: (text) => vscode.l10n.t(text),
    userPrompts: () =>
      vscode.workspace
        .getConfiguration("opencode", d.getFolder()?.uri)
        .get<Array<{ id?: unknown; title?: unknown; description?: unknown; text?: unknown }>>("promptLibrary", []),
    selection: () => {
      const editor = vscode.window.activeTextEditor;
      return editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
    },
    filePath: () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.scheme === "file" ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
    },
    diff: async () => {
      const cwd = d.getFolder()?.uri.fsPath;
      // The prompt catalog is posted before the trust check, and git honours repository config
      // (e.g. `core.fsmonitor`) that can run arbitrary commands: never spawn it untrusted.
      if (!cwd || d.trustBlocked()) return "";
      const diff = await workingDiff(cwd);
      return diff ? formatPromptDiff(diff) : "";
    },
    problems: async () => {
      const file = vscode.window.activeTextEditor?.document.uri.toString();
      const items = vscode.languages
        .getDiagnostics()
        .flatMap(([uri, list]) =>
          file && uri.toString() !== file
            ? []
            : list.map((diag) => ({ uri: uri.path, startLine: diag.range.start.line, message: diag.message, severity: diag.severity })),
        );
      return formatPromptDiagnostics(items);
    },
  });
}

export function createFileIconThemeService(getFolder: FolderGetter): FileIconThemeService {
  return new FileIconThemeService({
    themeId: () => vscode.workspace.getConfiguration("workbench").get<string | null>("iconTheme") ?? undefined,
    variant: () => {
      const kind = vscode.window.activeColorTheme.kind;
      if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) return "highContrast";
      return kind === vscode.ColorThemeKind.Light ? "light" : "dark";
    },
    associations: () => vscode.workspace.getConfiguration("files", getFolder()?.uri).get<Record<string, string>>("associations", {}),
    languages: () =>
      vscode.extensions.all.flatMap((ext) => {
        const contributed = ext.packageJSON?.contributes?.languages as LanguageContribution[] | undefined;
        return contributed ?? [];
      }),
    locate: (id) => {
      for (const ext of vscode.extensions.all) {
        const themes = ext.packageJSON?.contributes?.iconThemes as Array<{ id: string; path: string }> | undefined;
        const theme = themes?.find((t) => t.id === id);
        if (!theme || ext.extensionUri.scheme !== "file") continue;
        const jsonPath = path.join(ext.extensionUri.fsPath, theme.path.replace(/^\.\//, ""));
        return { jsonPath, baseDir: path.dirname(jsonPath) };
      }
      return undefined;
    },
    readFile: (file) => vscode.workspace.fs.readFile(vscode.Uri.file(file)),
  });
}
