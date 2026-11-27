import { describe, expect, it, vi } from "vitest";
import { toAuthItems } from "../../src/auth/logins";
import { OpenCodeClient, type Connection } from "../../src/client/http";
import type { SdkHost } from "../../src/sdk/bridge";
import { isConnectHostMessage, isConnectWebviewMessage } from "../../src/shared/protocolGuards";

function connection(api: Record<string, unknown>): Connection {
  return { key: "test", embedded: true, baseUrl: "in-process", api: api as unknown as SdkHost };
}

describe("Connect protocol guards", () => {
  it("accepts a well-formed key connect message and rejects oversized secrets", () => {
    expect(
      isConnectWebviewMessage({
        type: "connectKey",
        integrationID: "openai",
        key: "sk-short",
        answer: { region: "eu" },
        label: "work",
      }),
    ).toBe(true);
    expect(isConnectWebviewMessage({ type: "connectKey", integrationID: "openai", key: "x".repeat(9000), answer: {} })).toBe(false);
    expect(isConnectWebviewMessage({ type: "connectKey", integrationID: "openai", key: "k", answer: [] })).toBe(false);
  });

  it("accepts a real-sized integration catalog", () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      id: `p${i}`,
      name: `Provider ${i}`,
      methods: [{ type: "key" }],
      connections: [],
    }));
    expect(isConnectHostMessage({ type: "integrations", items, credentials: [] })).toBe(true);
  });

  it("rejects unknown message types and stale attempt shapes", () => {
    expect(isConnectWebviewMessage({ type: "stealCredential" })).toBe(false);
    expect(isConnectHostMessage({ type: "attemptClosed" })).toBe(true);
    expect(
      isConnectHostMessage({
        type: "attempt",
        attempt: { kind: "oauth", integrationID: "a", methodLabel: "Sign in", attemptID: "1" },
      }),
    ).toBe(false);
  });
});

describe("integration discovery", () => {
  it("passes the requested directory as a location", async () => {
    const list = vi.fn().mockResolvedValue({ location: { directory: "/work" }, data: [] });
    const client = OpenCodeClient.create(connection({ integration: { list } }));
    expect(await client.integrations("/work")).toEqual([]);
    expect(list).toHaveBeenCalledWith({ location: { directory: "/work" } }, undefined);
  });
});

describe("status/account projection", () => {
  it("uses the same credentials as the Connect panel and puts active accounts first", () => {
    const items = toAuthItems([
      { id: "c1", integrationID: "opencode", label: "Personal", active: false, type: "oauth" },
      { id: "c2", integrationID: "github-copilot", label: "Work", active: true, type: "oauth" },
    ]);
    expect(items.map((item) => item.label)).toEqual(["Work", "Personal"]);
    expect(items[0]).toMatchObject({ id: "c2", integrationID: "github-copilot", detail: "oauth · active" });
  });
});

describe("credential projection", () => {
  it("never exposes a stored secret to the webview", async () => {
    const list = vi.fn().mockResolvedValue([
      { id: "c1", integrationID: "openai", label: "work", active: true, value: { type: "key", key: "sk-very-secret" } },
      { id: "c2", integrationID: "anthropic", label: "personal", active: false, value: { type: "oauth", access: "token" } },
      { id: "c3", integrationID: "broken", label: "bad", active: true, value: { type: "unknown" } },
    ]);
    const client = OpenCodeClient.create(connection({ credential: { list } }));
    const credentials = await client.credentials();
    expect(credentials).toEqual([
      { id: "c1", integrationID: "openai", label: "work", active: true, type: "key" },
      { id: "c2", integrationID: "anthropic", label: "personal", active: false, type: "oauth" },
    ]);
    expect(JSON.stringify(credentials)).not.toContain("sk-very-secret");
    expect(JSON.stringify(credentials)).not.toContain("token");
  });
});
