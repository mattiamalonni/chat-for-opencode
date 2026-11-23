import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // Some agent/terminal harnesses export this; it makes the VS Code binary launch as plain Node
  // instead of Electron, so every CLI flag is rejected as a bad option.
  delete process.env.ELECTRON_RUN_AS_NODE;
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
    writeFileSync(
      fake,
      `@echo off\r\nset MOCK_STATE_FILE=${stateFile}\r\nset MOCK_LATE_CATALOG=1\r\n"${process.execPath}" "${mock}" %*\r\n`,
    );
  } else {
    writeFileSync(fake, `#!/bin/sh\nMOCK_STATE_FILE="${stateFile}" MOCK_LATE_CATALOG=1 exec "${process.execPath}" "${mock}" "$@"\n`);
    chmodSync(fake, 0o755);
  }
  const real = process.env.OC_IT_REAL === "1";
  const settings = real
    ? { "opencode.executablePath": "opencode", "opencode.sessionPermissions": [{ action: "edit", resource: "*", effect: "ask" }] }
    : { "opencode.executablePath": fake };
  writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify(settings, null, 2));
  if (real) {
    writeFileSync(join(workspace, "a.txt"), "a\n");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["-c", "user.email=it@test", "-c", "user.name=it", "commit", "-qm", "init"], { cwd: workspace });
  }

  const version = process.env.VSCODE_TEST_VERSION ?? "stable";
  const e2e = process.env.OC_IT_E2E === "1";
  const cdpPort = process.env.OC_IT_CDP_PORT ?? "9222";
  await runTests({
    version,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(__dirname, "suite", "index.js"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      ...(e2e ? [`--remote-debugging-port=${cdpPort}`] : []),
    ],
    extensionTestsEnv: {
      OC_IT_WORKSPACE: workspace,
      OC_IT_SUITE: e2e && real ? "webview.real.e2e.test.js" : e2e ? "webview.e2e.test.js" : real ? "real.test.js" : "extension.test.js",
      OC_IT_E2E: e2e ? "1" : "0",
      OC_IT_CDP_PORT: cdpPort,
    },
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
