import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const root = resolve(__dirname, "../../..");
  const workspace = mkdtempSync(join(tmpdir(), "oc-it-ws-"));
  mkdirSync(join(workspace, "src"));
  mkdirSync(join(workspace, ".vscode"));
  writeFileSync(join(workspace, "src", "a.txt"), "b\n");
  writeFileSync(join(workspace, "src", "app.ts"), "export const one = 1;\nexport const two = 2;\n");

  // Fake `opencode` executable backed by the mock server, so the real spawn/health/restart
  // code path runs without consuming tokens.
  const stateFile = join(workspace, ".mock-state.json");
  const fake = join(workspace, process.platform === "win32" ? "opencode.cmd" : "opencode");
  const mock = join(root, "out", "test", "mock", "mockServer.js");
  if (process.platform === "win32") {
    writeFileSync(fake, `@echo off\r\nset MOCK_STATE_FILE=${stateFile}\r\n"${process.execPath}" "${mock}" %*\r\n`);
  } else {
    writeFileSync(fake, `#!/bin/sh\nMOCK_STATE_FILE="${stateFile}" exec "${process.execPath}" "${mock}" "$@"\n`);
    chmodSync(fake, 0o755);
  }
  writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify({ "opencode.executablePath": fake }, null, 2));

  const version = process.env.VSCODE_TEST_VERSION ?? "stable";
  await runTests({
    version,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(__dirname, "suite", "index.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
    extensionTestsEnv: { OC_IT_WORKSPACE: workspace },
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
