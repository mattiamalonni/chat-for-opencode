// CJS export avoids Node's module-type warning: this repo's package.json is CommonJS.
const { defineConfig } = require("oxfmt");

module.exports = defineConfig({
  printWidth: 140,
  // Preserve the existing package.json key order; oxfmt sorts keys by default.
  sortPackageJson: false,
  ignorePatterns: [
    "dist/**",
    "out/**",
    ".vscode-test/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "*.vsix",
    "src/shared/openapi.generated.ts",
    "test/fixtures/",
  ],
});
