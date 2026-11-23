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
  writeFileSync(
    join(workspace, "src", "app.ts"),
    process.env.OC_IT_HERO === "1"
      ? `import { createClient } from "@opencode/client";

/** Talks to the local \`opencode serve\` instance. */
export async function startServer(folder: Uri): Promise<Client> {
  const port = await freePort();
  const password = randomPassword();
  const endpoint = \`http://127.0.0.1:\${port}\`;

  const proc = spawn("opencode", ["serve", "--port", port], {
    cwd: folder.fsPath,
    env: { ...process.env, OPENCODE_PASSWORD: password },
  });

  await waitForHealth(endpoint);
  return createClient({ endpoint, password, proc });
}

async function waitForHealth(endpoint: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(\`\${endpoint}/api/event\`, { method: "HEAD" });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("opencode serve did not start");
}
`
      : "export const one = 1;\nexport const two = 2;\n",
  );

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
  const hero = process.env.OC_IT_HERO === "1";
  if (hero) {
    process.env.MOCK_MODEL_NAME = "Claude Sonnet 4.5";
    process.env.MOCK_REPLY = join(workspace, ".hero-reply.md");
    writeFileSync(
      process.env.MOCK_REPLY,
      `**\`startServer()\`** boots a managed \`opencode serve\` for the workspace:\n\n1. Reserves a free port and a random password.\n2. Spawns the CLI with \`--port\`, passing the secret via \`OPENCODE_PASSWORD\`.\n3. Polls \`GET /api/event\` until healthy, then returns a client.\n\nThe server stays the source of truth: the chat is rebuilt from history and kept live over SSE.`,
    );
  }
  const settings = real
    ? { "opencode.executablePath": "opencode", "opencode.sessionPermissions": [{ action: "edit", resource: "*", effect: "ask" }] }
    : {
        "opencode.executablePath": fake,
        ...(hero
          ? {
              "window.titleBarStyle": "custom",
              "window.title": "Chat for OpenCode — Visual Studio Code",
              "typescript.validate.enable": false,
              "javascript.validate.enable": false,
              "files.exclude": {
                "**/.vscode": true,
                "**/.mock-state.json": true,
                "**/.hero-reply.md": true,
                "**/opencode": true,
                "**/a.txt": true,
              },
            }
          : {}),
      };
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
      ...(hero
        ? [
            `--user-data-dir=${mkdtempSync(join(tmpdir(), "oc-it-hero-"))}`,
            `--extensions-dir=${mkdtempSync(join(tmpdir(), "oc-it-hero-ext-"))}`,
          ]
        : ["--disable-extensions"]),
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      ...(e2e ? [`--remote-debugging-port=${cdpPort}`] : []),
      ...(hero ? ["--window-size=1600,940", "--window-position=0,0"] : []),
    ],
    extensionTestsEnv: {
      OC_IT_WORKSPACE: workspace,
      OC_IT_SUITE:
        process.env.OC_IT_SUITE ??
        (e2e && real ? "webview.real.e2e.test.js" : e2e ? "webview.e2e.test.js" : real ? "real.test.js" : "extension.test.js"),
      OC_IT_E2E: e2e ? "1" : "0",
      OC_IT_CDP_PORT: cdpPort,
    },
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
