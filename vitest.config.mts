import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/webview/**", // browser bundle, exercised by the Playwright UI suite instead
        "src/**/*.d.ts", // type-only declarations, no executable statements
        "src/**/*.generated.ts", // produced by `npm run gen:types`, not hand-written logic
      ],
      // Deliberately low floor, not a quality target: ~241 unit tests cover the shared helpers
      // well, but some modules (notably controller.ts) have no dedicated suite, extension.ts
      // needs the VS Code host, and the webview is measured by Playwright. An 80% global gate
      // would fail CI from day one — ratchet these numbers up as suites are added.
      thresholds: {
        lines: 25,
        statements: 25,
        functions: 20,
        branches: 10,
      },
    },
  },
});
