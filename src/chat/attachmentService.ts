import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Attachment, DroppedFile } from "../shared/protocol";
import { MAX_ATTACHMENT_BYTES } from "./attachments";
import { attachmentFileName, evictOldestAttachments, isWithinDirectory, normalizePathKey } from "./tempAttachments";
import { isWithinDirectoryReal } from "./pathSafety";

const ATTACHMENT_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export function mimeFromName(name: string): string {
  return ATTACHMENT_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Owns everything about attachments: OS drops, the native picker, inline byte staging and the
 * allowlist that decides which `file:` URIs from the webview may be opened. The controller keeps
 * only the thin command delegates, and `send()` still uses `resolveAttachment` to build payloads.
 */
export class AttachmentService {
  private readonly tempAttachments = new Set<string>();
  private static readonly MAX_TEMP_ATTACHMENTS = 50;

  constructor(
    private readonly onAttachment: (item: Attachment) => void,
    private readonly notice: (kind: "tooLarge" | "unreadable", name: string, detail: string) => void,
    private readonly log: (line: string) => void,
    private readonly revealLine: (editor: vscode.TextEditor, line: number) => void,
  ) {}

  private get tempDir(): string {
    // OS temp is cleared by the system on reboot, so staged copies never linger indefinitely.
    return path.join(os.tmpdir(), "chat-for-opencode-attachments");
  }

  private tooLarge(name: string): void {
    this.notice("tooLarge", name, "");
  }

  private unreadable(name: string, detail: string): void {
    this.notice("unreadable", name, detail);
  }

  /** Persists inline bytes to an extension-owned temp file so its chip can be opened in an editor. */
  private async attachInline(name: string, base64: string, mime: string | undefined, detail?: string): Promise<void> {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      this.tooLarge(name);
      return;
    }
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      const file = path.join(this.tempDir, `${randomUUID()}-${attachmentFileName(name, mime)}`);
      await fs.writeFile(file, bytes);
      this.tempAttachments.add(normalizePathKey(file));
      // Evict after a successful write, so a failed write cannot drop a still-usable old copy.
      evictOldestAttachments(this.tempAttachments, AttachmentService.MAX_TEMP_ATTACHMENTS, (oldest) => {
        void fs.unlink(oldest).catch(() => undefined);
      });
      this.onAttachment({ uri: vscode.Uri.file(file).toString(), name, kind: "file", detail });
    } catch (err) {
      this.unreadable(name, err instanceof Error ? err.message : String(err));
    }
  }

  private async attachUri(uri: vscode.Uri, name?: string): Promise<void> {
    if (uri.scheme !== "file") return;
    const label = name || path.basename(uri.fsPath);
    const detail = vscode.workspace.asRelativePath(uri, false);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder && (await isWithinDirectoryReal(uri.fsPath, folder.uri.fsPath))) {
      // The server can read project files itself, preserving line ranges on @-mentions. A link that
      // resolves outside the folder is staged inline instead of being treated as a project file.
      this.onAttachment({ uri: uri.toString(), name: label, kind: "file", detail });
      return;
    }
    // Outside the workspace: send the content inline so the model actually receives it.
    const stat = await fs.stat(uri.fsPath);
    if (stat.size > MAX_ATTACHMENT_BYTES) return this.tooLarge(label);
    const bytes = await fs.readFile(uri.fsPath);
    await this.attachInline(label, bytes.toString("base64"), mimeFromName(label), detail);
  }

  async addFile(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== "file") return;
    try {
      await this.attachUri(uri);
    } catch (err) {
      this.unreadable(path.basename(uri.fsPath), err instanceof Error ? err.message : String(err));
    }
  }

  /** Files dropped into the webview, which cannot expose a path for OS drags. */
  async dropFiles(files: DroppedFile[]): Promise<void> {
    for (const file of files) {
      try {
        if (file.base64) {
          await this.attachInline(file.name, file.base64, file.mime, file.name);
          continue;
        }
        const uri = file.uri
          ? (() => {
              const parsed = vscode.Uri.parse(file.uri);
              return parsed.scheme === "file" ? parsed : undefined;
            })()
          : file.path
            ? vscode.Uri.file(file.path)
            : undefined;
        if (uri) await this.attachUri(uri, file.name);
      } catch (err) {
        this.log(`[chat] failed to attach dropped file ${file.name}: ${String(err)}`);
      }
    }
  }

  /** Native file picker: a reliable alternative to drag & drop, which VS Code gates behind Shift. */
  async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      title: vscode.l10n.t("Attach files to the chat"),
      openLabel: vscode.l10n.t("Attach"),
    });
    if (!uris) return;
    for (const uri of uris) {
      try {
        await this.attachUri(uri);
      } catch (err) {
        this.log(`[chat] failed to attach picked file ${uri.fsPath}: ${String(err)}`);
      }
    }
  }

  /** True for an inline copy this service staged itself — the only temp paths the webview may open. */
  private isTempCopy(target: vscode.Uri): boolean {
    return this.tempAttachments.has(normalizePathKey(target.fsPath)) && isWithinDirectory(target.fsPath, this.tempDir);
  }

  /**
   * Opens an attachment chip: a temp copy or a project file. Both are real paths; the URI arrives
   * from the webview, so nothing outside the workspace/temp allowlist may be opened.
   */
  async open(uri: string): Promise<void> {
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(uri);
    } catch {
      return;
    }
    if (parsed.scheme !== "file") return;
    const target = parsed.with({ query: "", fragment: "" });
    const file = normalizePathKey(target.fsPath);
    const folder = vscode.workspace.getWorkspaceFolder(target);
    const tempCopy = this.isTempCopy(target) && (await isWithinDirectoryReal(target.fsPath, this.tempDir));
    const projectFile = !!folder && (await isWithinDirectoryReal(target.fsPath, folder.uri.fsPath));
    if (!tempCopy && !projectFile) {
      this.log(`[chat] blocked an attempt to open an attachment outside the workspace: ${file}`);
      return;
    }
    // @-mentions of a selection carry a 1-based `?start=&end=` range: jump to its first line.
    let line: number | undefined;
    try {
      const start = Number(new URLSearchParams(parsed.query).get("start"));
      if (Number.isInteger(start) && start > 0) line = start - 1;
    } catch {
      // A malformed range simply opens the file at the top.
    }
    if (line === undefined) {
      // Preserve `vscode.open`: it is the only way to show images/PDFs, not just text documents.
      await vscode.commands.executeCommand("vscode.open", target);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    this.revealLine(editor, line);
  }

  async dispose(): Promise<void> {
    for (const file of this.tempAttachments) {
      try {
        await fs.unlink(file);
      } catch {
        // Best effort: the OS may already have removed the temp file.
      }
    }
    this.tempAttachments.clear();
  }
}
