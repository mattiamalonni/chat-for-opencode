import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSTRUCTION_FILE,
  formatInstruction,
  ProjectInstructionService,
  type ProjectInstructionHooks,
} from "../../src/chat/projectInstructions";

function hooks(overrides: Partial<ProjectInstructionHooks<{ path: string }>> = {}) {
  return {
    t: (text: string, ...args: (string | number)[]) => args.reduce<string>((value, arg) => value.replace("{0}", String(arg)), text),
    folder: () => "/work",
    pickTarget: vi.fn(async () => DEFAULT_INSTRUCTION_FILE),
    resolveTarget: async (targetPath: string) => ({ uri: { path: targetPath }, path: targetPath }),
    read: async () => "# Project\n",
    write: vi.fn(async () => undefined),
    now: () => new Date("2026-11-22T10:00:00Z"),
    warn: vi.fn(),
    info: vi.fn(),
    ...overrides,
  } satisfies ProjectInstructionHooks<{ path: string }>;
}

describe("project instructions", () => {
  it("formats a dated Markdown section and caps long replies", () => {
    expect(formatInstruction("Use tabs.", new Date("2026-11-22T10:00:00Z"))).toBe("\n\n## OpenCode note (2026-11-22)\n\nUse tabs.\n");
    expect(formatInstruction("x".repeat(3000)).length).toBeLessThan(2200);
  });

  it("appends to AGENTS.md and reports the saved path", async () => {
    const h = hooks();
    await new ProjectInstructionService(h).save("Use tabs.");
    expect(h.write).toHaveBeenCalledWith({ path: "AGENTS.md" }, "# Project\n\n## OpenCode note (2026-11-22)\n\nUse tabs.\n");
    expect(h.info).toHaveBeenCalledWith("Instruction saved to AGENTS.md.");
  });

  it("does not append the same note twice", async () => {
    const h = hooks({ read: async () => "# Project\n\n## OpenCode note (2026-11-22)\n\nUse tabs.\n" });
    await new ProjectInstructionService(h).save("Use tabs.");
    expect(h.write).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith("This note is already in AGENTS.md.");
  });

  it("refuses to write when there is no folder or the target escapes it", async () => {
    const noFolder = hooks({ folder: () => undefined });
    await new ProjectInstructionService(noFolder).save("Use tabs.");
    expect(noFolder.write).not.toHaveBeenCalled();
    expect(noFolder.warn).toHaveBeenCalled();

    const escaped = hooks({ resolveTarget: async () => undefined });
    await new ProjectInstructionService(escaped).save("Use tabs.");
    expect(escaped.write).not.toHaveBeenCalled();
  });

  it("respects a cancelled target picker", async () => {
    const h = hooks({ pickTarget: async () => undefined });
    await new ProjectInstructionService(h).save("Use tabs.");
    expect(h.write).not.toHaveBeenCalled();
  });
});
