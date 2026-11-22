import { describe, expect, it, vi } from "vitest";
import { PromptLibraryService, resolvePromptVariables } from "../../src/chat/promptLibrary";

function service(overrides: Partial<ConstructorParameters<typeof PromptLibraryService>[0]> = {}) {
  return new PromptLibraryService({
    t: (text) => text,
    userPrompts: () => [],
    selection: () => "const x = 1;",
    filePath: () => "src/app.ts",
    diff: async () => "DIFF",
    problems: async () => "PROBLEMS",
    ...overrides,
  });
}

describe("prompt variables", () => {
  it("resolves known variables and leaves unrelated text alone", () => {
    expect(
      resolvePromptVariables("File $file, selection:\n$selection\n$diff $problems $filename", {
        file: "a.ts",
        selection: "sel",
        diff: "d",
        problems: "p",
      }),
    ).toBe("File a.ts, selection:\nsel\nd p $filename");
  });

  it("turns missing variables into empty strings", () => {
    expect(resolvePromptVariables("A$file B", {})).toBe("A B");
  });
});

describe("PromptLibraryService", () => {
  it("publishes the curated prompts plus validated user prompts", () => {
    const catalog = service({
      userPrompts: () => [
        { id: "mine", title: "Mine", text: "Do $file" },
        { id: "broken", title: 7 as never, text: "x" },
      ],
    }).catalog();
    expect(catalog.map((p) => p.id)).toEqual(["explain", "tests", "bugs", "optimize", "document", "review", "problems", "commit", "mine"]);
    expect(catalog.at(-1)?.description).toBe("Custom prompt");
  });

  it("resolves a prompt with all current context", async () => {
    const resolved = await service().resolve("review");
    expect(resolved).toContain("DIFF");
    expect(resolved).toContain("Review these uncommitted changes");
  });

  it("resolves selection and file variables in a built-in prompt", async () => {
    const resolved = await service().resolve("bugs");
    expect(resolved).toContain("const x = 1;");
  });

  it("returns nothing for an unknown id", async () => {
    expect(await service().resolve("nope")).toBeUndefined();
  });

  it("fetches diff and problems from the injected context providers", async () => {
    const diff = vi.fn(async () => "d");
    const problems = vi.fn(async () => "p");
    await service({ diff, problems }).resolve("explain");
    expect(diff).toHaveBeenCalled();
    expect(problems).toHaveBeenCalled();
  });
});
