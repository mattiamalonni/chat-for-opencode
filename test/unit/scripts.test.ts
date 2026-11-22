import { describe, expect, it } from "vitest";
import manifest from "../../package.json";

const scripts = manifest.scripts as Record<string, string>;

describe("npm scripts", () => {
  it("uses cross-env for every inline environment variable (Windows compatibility)", () => {
    for (const [name, script] of Object.entries(scripts)) {
      const bareEnv = /(?:^|[&;]\s*)([A-Z][A-Z0-9_]*)=(?!"|')/.exec(script);
      expect(bareEnv, `${name} assigns ${bareEnv?.[1]} without cross-env`).toBeNull();
    }
    expect(manifest.devDependencies).toHaveProperty("cross-env");
  });

  it("makes verify run every gate CI runs", () => {
    for (const gate of [
      "npm run audit",
      "npm run verify:types",
      "npm run lint",
      "npm run format:check",
      "npm run typecheck",
      "npm run test:coverage",
      "npm run test:coverage:ui",
      "npm run test:ui:prod",
      "npm run test:integration",
    ]) {
      expect(scripts.verify).toContain(gate);
    }
  });

  it("enforces a webview coverage floor by default, not only in CI", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync("scripts/ui-coverage.mjs", "utf8"));
    expect(source).toContain("OC_UI_COVERAGE_MIN ?? 55");
  });
});
