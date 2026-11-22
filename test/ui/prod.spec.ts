/**
 * Smoke test for the artefact that actually ships: minified bundle, no source maps, no dev JSX.
 * It deliberately stays small — the full UI suite runs against the development bundle so coverage
 * can be mapped back to TypeScript sources.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { HostMessage } from "../../src/shared/protocol";
import { STRINGS } from "../../src/shared/strings";

const HARNESS = "file://" + join(__dirname, "harness.html");
const DIST = join(__dirname, "..", "..", "dist");

/**
 * The comment above is a promise, not a test: without these assertions a `compile:prod` regression
 * could ship an unminified bundle (with source maps and dev JSX) and every check below would still pass.
 */
test("the production artefact is minified and has no source maps", () => {
  // `npm run test:ui` also collects this file against a development bundle; the artefact check
  // belongs to the dedicated production gate only.
  test.skip(!process.env.OC_PROD_BUNDLE, "only meaningful after compile:prod");
  const bundle = readFileSync(join(DIST, "webview.js"), "utf8");
  expect(bundle).not.toContain("//# sourceMappingURL");
  expect(bundle).not.toMatch(/\bjsxDEV\b|_jsx-runtime-dev|jsx-dev-runtime/);
  expect(readdirSync(DIST).filter((name) => name.endsWith(".map"))).toEqual([]);
  // A development bundle has ~24k lines (vs ~100 minified); keep a wide margin so dependency
  // growth cannot trip this, while an accidental `sourcemap/minify: false` build still fails.
  expect(bundle.split("\n").filter((line) => line.trim().length > 0).length).toBeLessThan(200);
});

test("the production bundle boots and posts a prompt", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(HARNESS);

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __posted?: unknown[] }).__posted?.some((m) => (m as { type?: string }).type === "ready") ?? false,
      ),
    )
    .toBe(true);
  const host = (msg: HostMessage) => page.evaluate((m) => window.postMessage(m, "*"), msg as unknown as Record<string, unknown>);
  await host({ type: "init", strings: { ...STRINGS }, platform: "mac", folders: [], issuesUrl: "https://example.invalid" });
  await host({ type: "connection", status: "connected" });
  await host({
    type: "catalog",
    models: [{ id: "m", modelID: "m", providerID: "p", name: "Model", enabled: true, variants: [], limit: { context: 1000, output: 100 } }],
    agents: [{ id: "build", name: "Build", description: "Default", mode: "primary", hidden: false }],
    skills: [],
    selectedModel: { id: "m", providerID: "p" },
    selectedAgent: "build",
  });
  await host({ type: "session", session: { id: "s1", busy: false, messages: [], permissions: [], forms: [] } });

  const input = page.getByRole("textbox", { name: STRINGS.inputLabel });
  await expect(input).toBeVisible();
  await input.fill("production smoke");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __posted?: Array<{ type?: string; text?: string }> }).__posted?.some(
            (m) => m.type === "send" && m.text === "production smoke",
          ) ?? false,
      ),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});
