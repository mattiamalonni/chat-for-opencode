/**
 * Saves a useful reply as a project instruction (AGENTS.md by default).
 *
 * Pure formatting plus injected host hooks, so the append / deduplicate / refuse flow is testable
 * without VS Code. All paths are resolved and confined by the host before anything is written.
 */

export const DEFAULT_INSTRUCTION_FILE = "AGENTS.md";
export const MAX_INSTRUCTION_CHARS = 2_000;

export function formatInstruction(text: string, now = new Date()): string {
  const body = text.trim().slice(0, MAX_INSTRUCTION_CHARS);
  return `\n\n## OpenCode note (${now.toISOString().slice(0, 10)})\n\n${body}\n`;
}

export interface ProjectInstructionHooks<TUri = unknown> {
  t(text: string, ...args: (string | number)[]): string;
  folder(): string | undefined;
  pickTarget(): Promise<string | undefined>;
  resolveTarget(targetPath: string): Promise<{ uri: TUri; path: string } | undefined>;
  read(uri: TUri): Promise<string | undefined>;
  write(uri: TUri, content: string): Promise<void>;
  now(): Date;
  warn(message: string): void;
  info(message: string): void;
}

export class ProjectInstructionService<TUri = unknown> {
  constructor(private readonly hooks: ProjectInstructionHooks<TUri>) {}

  async save(text: string): Promise<void> {
    const h = this.hooks;
    const body = text.trim();
    if (!body) return;
    if (!h.folder()) {
      h.warn(h.t("Open a workspace folder before saving an instruction."));
      return;
    }
    const targetPath = await h.pickTarget();
    if (!targetPath) return;
    const target = await h.resolveTarget(targetPath);
    if (!target) {
      h.warn(h.t("The instruction file is outside the workspace, so it cannot be written."));
      return;
    }
    const current = (await h.read(target.uri)) ?? "";
    if (current.includes(body)) {
      h.info(h.t("This note is already in {0}.", target.path));
      return;
    }
    await h.write(target.uri, current.replace(/\s*$/, "") + formatInstruction(body, h.now()));
    h.info(h.t("Instruction saved to {0}.", target.path));
  }
}
