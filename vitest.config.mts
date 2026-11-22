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
        "src/webview/**", // measured separately by `npm run test:coverage:ui` (Chromium V8 + source maps)
        "src/**/*.d.ts", // type-only declarations, no executable statements
        "src/**/*.generated.ts", // produced by `npm run gen:types`, not hand-written logic
      ],
      // Enforced on one CI runner (`npm run test:coverage`). Floors track the ~53% actual and are
      // ratcheted as suites are added; controller.ts and extension.ts still need the VS Code host,
      // while the webview is measured by Playwright. Raise these together with new tests.
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 50,
        branches: 45,
      },
    },
  },
});
