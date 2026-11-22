import { describe, expect, it, vi } from "vitest";
import { ApplyCodeService, buildProposal, looksLikePatch, type ApplyCodeHooks } from "../../src/chat/applyCode";

interface FakeUri {
  path: string;
}

type SpiedHooks = ApplyCodeHooks<FakeUri> & {
  preview: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

function hooks(overrides: Partial<ApplyCodeHooks<FakeUri>> = {}): SpiedHooks {
  return {
    t: (text: string, ...args: (string | number)[]) => args.reduce<string>((value, arg) => value.replace("{0}", String(arg)), text),
    folder: () => "/work",
    activePath: () => undefined,
    resolve: async (targetPath) => ({ uri: { path: targetPath }, path: targetPath }),
    pickPath: async (candidates) => candidates[0],
    read: async () => "old\n",
    preview: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    write: vi.fn(async () => undefined),
    warn: vi.fn(),
    info: vi.fn(),
    ...overrides,
  } as SpiedHooks;
}

describe("code proposals", () => {
  it("distinguishes full files from unified patches and applies them", () => {
    expect(looksLikePatch("const a = 1;")).toBe(false);
    expect(buildProposal("old\n", "new\n")).toEqual({ mode: "file", content: "new\n" });
    const patch = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new\n";
    expect(looksLikePatch(patch)).toBe(true);
    expect(buildProposal("old\n", patch)?.content).toBe("new\n");
  });

  it("rejects a patch that does not apply to the current file", () => {
    expect(buildProposal("completely different\n", "@@ -1 +1 @@\n-old\n+new\n")).toBeUndefined();
  });
});

describe("ApplyCodeService", () => {
  it("previews first and writes only after Accept", async () => {
    const h = hooks({ confirm: vi.fn(async () => false) });
    await new ApplyCodeService(h).apply("new content", "src/a.ts");
    expect(h.preview).toHaveBeenCalledWith({ path: "src/a.ts" }, "old\n", "new content");
    expect(h.write).not.toHaveBeenCalled();
    expect(h.info).not.toHaveBeenCalled();

    h.confirm.mockResolvedValue(true);
    await new ApplyCodeService(h).apply("new content", "src/a.ts");
    expect(h.write).toHaveBeenCalledWith({ path: "src/a.ts" }, "new content");
    expect(h.info).toHaveBeenCalledWith("Change applied to src/a.ts");
  });

  it("never writes outside the workspace and warns when no folder is open", async () => {
    const escaped = hooks({ resolve: async () => undefined });
    await new ApplyCodeService(escaped).apply("x", "../secret.ts");
    expect(escaped.preview).not.toHaveBeenCalled();
    expect(escaped.warn).toHaveBeenCalled();

    const noFolder = hooks({ folder: () => undefined });
    await new ApplyCodeService(noFolder).apply("x", "a.ts");
    expect(noFolder.preview).not.toHaveBeenCalled();
  });

  it("uses the active editor as the candidate when the reply has no file reference", async () => {
    const h = hooks({ activePath: () => "src/open.ts", pickPath: vi.fn(async () => undefined) });
    await new ApplyCodeService(h).apply("x");
    expect(h.pickPath).not.toHaveBeenCalled();
    expect(h.preview).toHaveBeenCalledWith({ path: "src/open.ts" }, "old\n", "x");
  });
});
