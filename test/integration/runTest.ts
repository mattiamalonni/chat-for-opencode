import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

  const real = process.env.OC_IT_REAL === "1";
  // The extension hosts OpenCode in-process. For the mock suite it connects to an in-test
  // OpenCode API through `opencode.endpoint`, which exercises the generated client (same adapter
  // as the embedded SDK) and lets tests drive scenarios through the mock's `__mock/*` routes.
  let mockServer: Awaited<ReturnType<(typeof import("../mock/mockServer"))["startMockServer"]>> | undefined;
  let settings: Record<string, unknown>;
  let userDataDir: string | undefined;
  if (real) {
    settings = {};
    // Permission settings are machine-scoped (a workspace cannot set them), so they go into the
    // user settings of an isolated profile.
    userDataDir = mkdtempSync(join(tmpdir(), "oc-it-user-"));
    mkdirSync(join(userDataDir, "User"));
    writeFileSync(
      join(userDataDir, "User", "settings.json"),
      JSON.stringify({ "opencode.sessionPermissions": [{ action: "edit", resource: "*", effect: "ask" }] }, null, 2),
    );
  } else {
    process.env.MOCK_LATE_CATALOG = "1";
    const { startMockServer } = await import("../mock/mockServer");
    mockServer = await startMockServer({ password: "pw", directory: workspace, stateFile: join(workspace, ".mock-state.json") });
    settings = { "opencode.endpoint": `http://opencode:pw@${mockServer.url.slice("http://".length)}` };
    // Inject a bridge so the *embedded* code path (ManagedServer -> createHost) is exercised too,
    // backed by the same mock API instead of a real model provider.
    writeFileSync(
      join(workspace, "sdk-bridge.mjs"),
      `const { OpenCode } = await import(${JSON.stringify(pathToFileURL(join(root, "node_modules/@opencode/client/dist/promise/index.js")).href)});\n` +
        `export function makeNetworkApi(baseUrl, password) {\n` +
        `  const headers = password ? { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } : {};\n` +
        `  return OpenCode.make({ baseUrl, headers });\n` +
        `}\n` +
        `export async function createHost() { return makeNetworkApi(process.env.OC_MOCK_ENDPOINT, process.env.OC_MOCK_PASSWORD || undefined); }\n`,
    );
  }
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
  try {
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
        ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
        ...(e2e ? [`--remote-debugging-port=${cdpPort}`] : []),
      ],
      extensionTestsEnv: {
        OC_IT_WORKSPACE: workspace,
        OC_IT_SUITE:
          process.env.OC_IT_SUITE ??
          (e2e && real ? "webview.real.e2e.test.js" : e2e ? "webview.e2e.test.js" : real ? "real.test.js" : "extension.test.js"),
        OC_IT_E2E: e2e ? "1" : "0",
        OC_IT_CDP_PORT: cdpPort,
        ...(mockServer
          ? {
              OC_SDK_BRIDGE_MODULE: join(workspace, "sdk-bridge.mjs"),
              OC_MOCK_ENDPOINT: mockServer.url,
              OC_MOCK_PASSWORD: "pw",
              OC_IT_MOCK_URL: mockServer.url,
            }
          : {}),
      },
    });
  } finally {
    await mockServer?.close();
  }
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
