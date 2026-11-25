import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { HostMessage } from "../../src/shared/protocol";

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { CatalogService } from "../../src/chat/catalogService";

function service(posted: HostMessage[]) {
  const globalState = { get: vi.fn(() => undefined), update: vi.fn(async () => {}) };
  const ctx = { globalState } as unknown as vscode.ExtensionContext;
  return {
    globalState,
    catalog: new CatalogService(
      ctx,
      (m) => posted.push(m),
      () => {},
      () => true,
    ),
  };
}

const models = [
  { id: "fast", modelID: "fast", providerID: "p", name: "Fast", enabled: true, variants: [] },
  { id: "old", modelID: "old", providerID: "p", name: "Old", enabled: false, variants: [] },
] as never;
const agents = [
  { id: "plan", name: "Plan", mode: "primary", hidden: false },
  { id: "build", name: "Build", mode: "primary", hidden: false },
  { id: "sub", name: "Sub", mode: "subagent", hidden: false },
] as never;

describe("CatalogService", () => {
  it("filters disabled models and subagents, defaulting to Build", () => {
    const { catalog } = service([]);
    catalog.setModelsAndAgents(models, null, agents);
    expect(catalog.models.map((m) => m.id)).toEqual(["fast"]);
    expect(catalog.agents.map((a) => a.id)).toEqual(["plan", "build"]);
    expect(catalog.selectedModel).toEqual({ id: "fast", providerID: "p" });
    expect(catalog.selectedAgent).toBe("build");
  });

  it("publishes the catalog with suggestions shaped for the webview", () => {
    const posted: HostMessage[] = [];
    const { catalog } = service(posted);
    catalog.setModelsAndAgents(models, null, agents);
    catalog.skills = [{ id: "s", name: "Skill", description: "d", path: "", content: "" }];
    catalog.commands = [{ name: "init", description: "cmd" }];
    catalog.publish();
    const message = posted.at(-1);
    expect(message?.type).toBe("catalog");
    if (message?.type !== "catalog") throw new Error("expected catalog");
    expect(message.skills).toEqual([{ id: "s", name: "Skill", description: "d" }]);
    expect(message.commands).toEqual([
      { name: "init", description: "cmd" },
      { name: "fork", description: "Fork the conversation, then send the rest of the prompt in the new branch" },
      { name: "compact", description: "Compact the conversation, then send the rest of the prompt" },
    ]);
  });

  it("lets local /fork and /compact shadow server commands with the same name", () => {
    const posted: HostMessage[] = [];
    const { catalog } = service(posted);
    catalog.commands = [
      { name: "fork", description: "server fork" },
      { name: "compact", description: "server compact" },
      { name: "init", description: "cmd" },
    ];
    catalog.publish();
    const message = posted.at(-1);
    if (message?.type !== "catalog") throw new Error("expected catalog");
    expect(message.commands).toEqual([
      { name: "init", description: "cmd" },
      { name: "fork", description: "Fork the conversation, then send the rest of the prompt in the new branch" },
      { name: "compact", description: "Compact the conversation, then send the rest of the prompt" },
    ]);
  });

  it("persists the selection in globalState", async () => {
    const { catalog, globalState } = service([]);
    await catalog.selectModel({ id: "fast", providerID: "p" });
    await catalog.selectAgent("plan");
    expect(globalState.update).toHaveBeenCalledWith("opencode.lastModel", { id: "fast", providerID: "p" });
    expect(globalState.update).toHaveBeenCalledWith("opencode.lastAgent", "plan");
  });
});
