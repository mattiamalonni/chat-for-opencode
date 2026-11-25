// CJS export avoids Node's module-type warning: this repo's package.json is CommonJS.
const { defineConfig } = require("oxlint");

module.exports = defineConfig({
  // The previous ESLint setup had no unicorn/oxc rules; keep the plugin set aligned.
  plugins: ["eslint", "typescript"],
  ignorePatterns: ["dist/**", "out/**", ".vscode-test/**", "test-results/**", "playwright-report/**", "esbuild.mjs", "scripts/**/*.mjs"],
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "typescript/no-explicit-any": "error",
    eqeqeq: ["error", "always", { null: "ignore" }],
    "no-console": ["error", { allow: ["warn", "error"] }],
  },
  overrides: [
    {
      files: ["test/**/*.ts", "*.config.ts", "*.config.mjs"],
      rules: { "no-console": "off" },
    },
  ],
});
