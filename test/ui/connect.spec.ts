import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
import type { ConnectHostMessage, ConnectWebviewMessage } from "../../src/shared/protocol";
import { STRINGS } from "../../src/shared/strings";

const HARNESS = "file://" + join(__dirname, "connect-harness.html");

async function host(page: Page, msg: ConnectHostMessage): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, "*"), msg as unknown as Record<string, unknown>);
}

async function posted(page: Page): Promise<ConnectWebviewMessage[]> {
  return page.evaluate(() => (window as unknown as { __posted: ConnectWebviewMessage[] }).__posted);
}

const ANTHROPIC = {
  id: "anthropic",
  name: "Anthropic",
  methods: [{ type: "key" as const }, { type: "env" as const, names: ["ANTHROPIC_API_KEY"] }],
  connections: [],
};

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "OpenCode · /connect" })).toBeVisible();
  await host(page, { type: "init", strings: STRINGS, platform: "mac" });
  await host(page, { type: "integrations", items: [ANTHROPIC], credentials: [] });
  // The real host clears the busy flag after loading; the harness has no controller to do it.
  await host(page, { type: "busy", busy: false });
});

test("posts a ready message and sends a key without keeping it in the input", async ({ page }) => {
  expect((await posted(page))[0]).toEqual({ type: "ready" });
  // Anthropic has one actionable method (key) plus an env hint: the picker is skipped.
  // The whole provider card is the click target, not a nested "Sign in" button.
  await page.locator(".connect-provider").first().click();
  await page.locator("#connect-key").fill("sk-test-secret");
  await page.getByRole("button", { name: STRINGS.connectSubmit }).click();
  expect((await posted(page)).at(-1)).toEqual({
    type: "connectKey",
    integrationID: "anthropic",
    key: "sk-test-secret",
    answer: {},
  });
  expect(await page.locator("#connect-key").inputValue()).toBe("");
});

test("renders provider form fields and OAuth attempts", async ({ page }) => {
  await host(page, {
    type: "integrations",
    items: [
      {
        id: "azure",
        name: "Azure",
        methods: [
          {
            type: "key",
            label: "API key",
            form: [{ key: "resourceName", title: "Resource name", type: "string", required: true }],
          },
        ],
        connections: [],
      },
    ],
    credentials: [],
  });
  // The whole provider card is the click target, not a nested "Sign in" button.
  await page.locator(".connect-provider").first().click();
  await page.getByLabel("Resource name").fill("my-models");
  await page.locator("#connect-key").fill("key");
  await page.getByRole("button", { name: STRINGS.connectSubmit }).click();
  expect((await posted(page)).at(-1)).toEqual({
    type: "connectKey",
    integrationID: "azure",
    key: "key",
    answer: { resourceName: "my-models" },
  });

  await host(page, {
    type: "attempt",
    attempt: {
      kind: "oauth",
      integrationID: "azure",
      integrationName: "Azure",
      methodID: "browser",
      methodLabel: "Browser sign-in",
      attemptID: "att_1",
      url: "https://example.com/authorize",
      instructions: "Open the page",
      paste: true,
    },
  });
  await expect(page.getByRole("button", { name: STRINGS.connectOpenBrowser })).toBeVisible();
  await page.locator("#connect-code").fill("code-123");
  await page.getByRole("button", { name: STRINGS.connectComplete }).click();
  expect((await posted(page)).at(-1)).toEqual({ type: "completeOAuth", code: "code-123" });

  // Once the browser flow finishes the host closes the attempt and the wizard returns to the list.
  await host(page, { type: "attemptStatus", status: "complete" });
  await expect(page.locator("#connect-code")).toBeHidden();
  await expect(page.locator(".connect-provider").first()).toBeVisible();
});

test("shows connected accounts at the top, active ones first", async ({ page }) => {
  await host(page, {
    type: "integrations",
    items: [ANTHROPIC, { id: "openai", name: "OpenAI", methods: [], connections: [] }],
    credentials: [
      { id: "c1", integrationID: "openai", label: "Personal", active: false, type: "oauth" },
      { id: "c2", integrationID: "anthropic", label: "Work", active: true, type: "key" },
    ],
  });
  const section = page.locator(".connect-connected");
  await expect(section.getByRole("heading", { name: STRINGS.connectConnectedAccounts })).toBeVisible();
  expect(await section.locator(".connect-account-main strong").allTextContents()).toEqual(["Work", "Personal"]);
  await expect(section.locator(".connect-badge").first()).toHaveText(STRINGS.connectActive);
});

test("renders provider options as a select and honours conditional fields", async ({ page }) => {
  await host(page, {
    type: "integrations",
    items: [
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        methods: [
          {
            id: "device",
            type: "oauth",
            label: "Login with GitHub Copilot",
            form: [
              {
                key: "deploymentType",
                title: "Select GitHub deployment type",
                required: true,
                type: "string",
                options: [
                  { value: "github.com", label: "GitHub.com" },
                  { value: "enterprise", label: "GitHub Enterprise" },
                ],
              },
              {
                key: "enterpriseUrl",
                title: "Enterprise URL",
                required: true,
                type: "string",
                when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
              },
            ],
          },
        ],
        connections: [],
      },
    ],
    credentials: [],
  });
  // GitHub Copilot exposes env + one OAuth method: go straight to the OAuth form.
  // The whole provider card is the click target, not a nested "Sign in" button.
  await page.locator(".connect-provider").first().click();
  const deployment = page.getByLabel("Select GitHub deployment type");
  await expect(deployment).toHaveValue("github.com");
  await expect(page.getByLabel("Enterprise URL")).toBeHidden();
  await deployment.selectOption("enterprise");
  await page.getByLabel("Enterprise URL").fill("company.ghe.com");
  await page.getByRole("button", { name: STRINGS.connectSubmit }).click();
  expect((await posted(page)).at(-1)).toEqual({
    type: "startOAuth",
    integrationID: "github-copilot",
    methodID: "device",
    answer: { deploymentType: "enterprise", enterpriseUrl: "company.ghe.com" },
  });
});

test("hides env-only methods and keeps the picker for multiple sign-in methods", async ({ page }) => {
  await host(page, {
    type: "integrations",
    items: [
      {
        id: "openai",
        name: "OpenAI",
        methods: [
          { type: "key" },
          { type: "env", names: ["OPENAI_API_KEY"] },
          { id: "chatgpt", type: "oauth", label: "Sign in with ChatGPT" },
        ],
        connections: [],
      },
    ],
    credentials: [],
  });
  // The whole provider card is the click target, not a nested "Sign in" button.
  await page.locator(".connect-provider").first().click();
  await expect(page.getByRole("button", { name: STRINGS.connectMethodKey })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with ChatGPT" })).toBeVisible();
  await expect(page.getByRole("button", { name: STRINGS.connectMethodEnv })).toHaveCount(0);
});
