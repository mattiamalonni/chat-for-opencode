import * as vscode from "vscode";
import type { Attachment, DroppedFile, HostMessage } from "../../shared/protocol";
import type { AttachmentService } from "../attachmentService";
import { translatedStrings } from "./controllerSupport";
import type { ControllerState } from "./controllerState";

/** Attachment pickup, notices and opening untrusted file/link references from chat content. */
export interface FileActionDeps {
  state: ControllerState;
  attachments: AttachmentService;
  post(msg: HostMessage): void;
  logWarn(line: string): void;
  isWithinWorkspace(path: string): Promise<boolean>;
}

export class ChatFileActions {
  constructor(private readonly d: FileActionDeps) {}

  addAttachment(item: Attachment): void {
    this.d.post({ type: "addAttachment", item });
  }

  noticeTooLarge(name: string): void {
    const s = translatedStrings();
    this.d.post({ type: "notice", error: { kind: "requestFailed", message: s["error.attachmentTooLarge"], detail: name, actions: [] } });
  }

  noticeUnreadable(name: string, detail: string): void {
    const s = translatedStrings();
    this.d.post({
      type: "notice",
      error: { kind: "requestFailed", message: s["error.attachmentUnreadable"], detail, actions: ["showLogs"] },
    });
    this.d.logWarn(`[chat] skipped unreadable attachment ${name}: ${detail}`);
  }

  async dropFiles(files: DroppedFile[]): Promise<void> {
    await this.d.attachments.dropFiles(files);
  }

  async pickFiles(): Promise<void> {
    await this.d.attachments.pickFiles();
  }

  /** Parses a chat file reference into a URI and an optional zero-based line. */
  private fileTarget(p: string): { uri: vscode.Uri; line?: number } | undefined {
    const folder = this.d.state.folder;
    if (!folder) return undefined;
    const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(p);
    const file = m?.[1] ?? p;
    const line = m?.[2] ? Number(m[2]) - 1 : undefined;
    const uri = file.startsWith("file:")
      ? vscode.Uri.parse(file)
      : /^([a-zA-Z]:[\\/]|\/)/.test(file)
        ? vscode.Uri.file(file)
        : vscode.Uri.joinPath(folder.uri, file);
    return { uri, line };
  }

  async openFile(p: string): Promise<void> {
    const target = this.fileTarget(p);
    if (!target) return;
    const d = this.d;
    // Rendered chat content is untrusted model output. Never open a path outside any opened folder,
    // even through `../` or a symlink that lexically points inside but resolves elsewhere.
    if (!(await d.isWithinWorkspace(target.uri.fsPath))) {
      d.logWarn(`[chat] blocked an attempt to open a file outside the workspace: ${target.uri.fsPath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(target.uri.with({ query: "" }));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (target.line !== undefined) this.revealLine(editor, target.line);
  }

  /**
   * A file tool reported this path and the user clicked its name. The click is the explicit consent
   * that untrusted prose never gives, so this is the one file-open path allowed outside the folders.
   */
  async openToolFile(p: string): Promise<void> {
    const target = this.fileTarget(p);
    if (!target) return;
    const doc = await vscode.workspace.openTextDocument(target.uri.with({ query: "" }));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (target.line !== undefined) this.revealLine(editor, target.line);
  }

  revealLine(editor: vscode.TextEditor, line: number): void {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  async openAttachment(uri: string): Promise<void> {
    await this.d.attachments.open(uri);
  }

  async openLink(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    await this.openFile(href.replace(/^\.\//, "").replace(/#L(\d+).*$/, ":$1"));
  }
}
