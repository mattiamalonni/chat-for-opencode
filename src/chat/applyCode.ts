import { applyPatch } from "../shared/patch";

/**
 * Turns a code block from a reply into a reviewable file proposal.
 *
 * The module is DOM- and host-free: every VS Code capability is injected as a hook, so the whole
 * preview → confirm → write flow is unit-testable. The host owns path containment and the actual
 * edit; the webview only sends the block text and the nearest file reference it found in the reply.
 */

export interface CodeProposal {
  mode: "file" | "patch";
  content: string;
}

const PATCH_START = /^(?:diff --git |@@ |--- |\+\+\+ )/m;

export function looksLikePatch(text: string): boolean {
  return PATCH_START.test(text);
}

/** Full-file blocks are written verbatim; unified diffs are applied to the current file. */
export function buildProposal(current: string, text: string): CodeProposal | undefined {
  if (looksLikePatch(text)) {
    const applied = applyPatch(current, text);
    return applied === undefined ? undefined : { mode: "patch", content: applied };
  }
  return { mode: "file", content: text };
}

export interface ApplyCodeHooks<TUri = unknown> {
  t(text: string, ...args: (string | number)[]): string;
  /** Workspace folder of the connected chat, or undefined when there is none. */
  folder(): string | undefined;
  /** Active editor path, offered first in the picker. */
  activePath(): string | undefined;
  /** Resolves and validates a path inside the folder; returns nothing when it escapes. */
  resolve(targetPath: string): Promise<{ uri: TUri; path: string } | undefined>;
  pickPath(candidates: string[]): Promise<string | undefined>;
  read(uri: TUri): Promise<string | undefined>;
  /** Opens a native diff between the real file and the proposed content. */
  preview(uri: TUri, current: string, proposed: string): Promise<void>;
  confirm(): Promise<boolean>;
  write(uri: TUri, content: string): Promise<void>;
  warn(message: string): void;
  info(message: string): void;
}

export class ApplyCodeService<TUri = unknown> {
  constructor(private readonly hooks: ApplyCodeHooks<TUri>) {}

  async apply(text: string, suggested?: string): Promise<void> {
    const h = this.hooks;
    const root = h.folder();
    if (!root) {
      h.warn(h.t("Open a workspace folder before applying code from a reply."));
      return;
    }
    const targetPath = await this.choosePath(suggested);
    if (!targetPath) return;
    const target = await h.resolve(targetPath);
    if (!target) {
      h.warn(h.t("The file is outside the workspace, so it cannot be changed from the chat."));
      return;
    }
    const current = (await h.read(target.uri)) ?? "";
    const proposal = buildProposal(current, text);
    if (!proposal) {
      h.warn(h.t("This code block is not a valid patch for the selected file"));
      return;
    }
    await h.preview(target.uri, current, proposal.content);
    if (!(await h.confirm())) return;
    await h.write(target.uri, proposal.content);
    h.info(h.t("Change applied to {0}", target.path));
  }

  private async choosePath(suggested?: string): Promise<string | undefined> {
    const h = this.hooks;
    // The suggested path is untrusted chat content: offer it, but never write without validation.
    const candidates = [...new Set([h.activePath(), suggested].filter((value): value is string => !!value))];
    const picked = candidates.length === 1 ? candidates[0] : await h.pickPath(candidates);
    return picked;
  }
}
