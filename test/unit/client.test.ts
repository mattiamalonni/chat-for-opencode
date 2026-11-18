import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, OpenCodeClient } from "../../src/client/http";
import { startMockServer, type MockServer } from "../mock/mockServer";

describe("OpenCodeClient against the mock server", () => {
  let mock: MockServer;
  let client: OpenCodeClient;
  beforeEach(async () => {
    mock = await startMockServer({ password: "secret", directory: "/work" });
    client = new OpenCodeClient({ baseUrl: mock.url, password: "secret" });
  });
  afterEach(() => mock.close());

  it("sends Basic auth with the fixed username 'opencode'", async () => {
    expect((await client.info()).version).toBe("2.2.7-mock");
    const bad = new OpenCodeClient({ baseUrl: mock.url, password: "wrong" });
    await expect(bad.info()).rejects.toMatchObject({ status: 401, tag: "UnauthorizedError" });
  });

  it("creates, lists, renames and deletes sessions", async () => {
    const s = await client.createSession({ directory: "/work", agent: "plan", model: { id: "mock-smart", providerID: "mock", variant: "high" } });
    expect(s.id).toMatch(/^ses_/);
    expect(mock.requests.at(-1)?.body).toEqual({
      location: { directory: "/work" },
      agent: "plan",
      model: { id: "mock-smart", providerID: "mock", variant: "high" },
    });
    expect((await client.listSessions("/work")).map((x) => x.id)).toEqual([s.id]);
    expect(mock.requests.at(-1)?.path).toBe("/api/session?directory=%2Fwork&limit=50&order=desc&parentID=null");
    await client.renameSession(s.id, "Renamed");
    expect((await client.getSession(s.id)).title).toBe("Renamed");
    await client.deleteSession(s.id);
    await expect(client.getSession(s.id)).rejects.toBeInstanceOf(ApiError);
  });

  it("paginates sessions with an opaque cursor and sends order only on the first page", async () => {
    const paged = await startMockServer({ password: "secret", directory: "/work", sessionPageSize: 2 });
    try {
      const c = new OpenCodeClient({ baseUrl: paged.url, password: "secret" });
      for (let i = 0; i < 3; i++) await c.createSession({ directory: "/work" });
      const first = await c.listSessionsPage("/work", 2);
      expect(first.items).toHaveLength(2);
      expect(first.next).toBeDefined();
      expect(paged.requests.at(-1)?.path).toContain("order=desc");
      const second = await c.listSessionsPage("/work", 2, first.next);
      expect(second.items).toHaveLength(1);
      expect(second.next).toBeUndefined();
      expect(paged.requests.at(-1)?.path).toContain("cursor=");
      expect(paged.requests.at(-1)?.path).not.toContain("order=");
    } finally {
      await paged.close();
    }
  });

  it("only sends permissions when configured", async () => {
    await client.createSession({ permissions: [] });
    expect(mock.requests.at(-1)?.body).toEqual({});
    await client.createSession({ permissions: [{ action: "edit", resource: "*", effect: "ask" }] });
    expect(mock.requests.at(-1)?.body).toEqual({ permissions: [{ action: "edit", resource: "*", effect: "ask" }] });
  });

  it("prompts with file attachments and reads back history in order", async () => {
    const s = await client.createSession({});
    await client.prompt(s.id, "hello", [{ uri: "file:///work/a.ts?start=1&end=2", name: "a.ts" }]);
    expect(mock.requests.at(-1)?.body).toEqual({ text: "hello", files: [{ uri: "file:///work/a.ts?start=1&end=2", name: "a.ts" }] });
    await waitForIdle(client, s.id);
    const msgs = await client.messages(s.id);
    expect(msgs.map((m) => m.type)).toEqual(["user", "assistant", "idle"]);
  });

  it("reads only messages newer than a known id, and reports an unknown overlap", async () => {
    const s = await client.createSession({});
    await client.prompt(s.id, "first");
    await waitForIdle(client, s.id);
    const first = await client.messages(s.id);
    await client.prompt(s.id, "second");
    for (let i = 0; i < 300; i++) {
      if ((await client.messages(s.id)).filter((m) => m.type === "idle").length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const all = await client.messages(s.id);
    expect((await client.messagesNewerThan(s.id, first[1].id))?.map((m) => m.id)).toEqual(all.slice(2).map((m) => m.id));
    expect(await client.messagesNewerThan(s.id, "msg_missing")).toBeUndefined();
    expect(mock.requests.at(-1)?.path).toContain("order=desc");
  });

  it("sends steer and queue delivery modes on the prompt", async () => {
    const s = await client.createSession({});
    await client.prompt(s.id, "queued", [], "queue");
    expect(mock.requests.at(-1)?.body).toEqual({ text: "queued", delivery: "queue" });
    await client.prompt(s.id, "now", [], "steer");
    expect(mock.requests.at(-1)?.body).toEqual({ text: "now", delivery: "steer" });
    await client.prompt(s.id, "plain");
    expect(mock.requests.at(-1)?.body).toEqual({ text: "plain" });
  });

  it("lists catalog data", async () => {
    expect((await client.models()).map((m) => m.id)).toEqual(["mock-fast", "mock-smart"]);
    expect(mock.requests.at(-1)?.path).toBe("/api/model?types=chat");
    expect((await client.defaultModel())?.id).toBe("mock-fast");
    expect((await client.agents()).map((a) => a.id)).toContain("plan");
    expect((await client.skills()).map((s) => s.id)).toEqual(["mock-review"]);
    expect(mock.requests.at(-1)?.path).toBe("/api/skill");
    expect((await client.commands()).map((c) => c.name)).toEqual(["mock-init"]);
    expect(mock.requests.at(-1)?.path).toBe("/api/command");
  });

  it("runs a slash command through the command endpoint", async () => {
    const s = await client.createSession({});
    await client.command(s.id, "mock-init", "some argument", [{ uri: "file:///work/a.ts", name: "a.ts" }]);
    expect(mock.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/session/${s.id}/command`,
      body: { name: "mock-init", text: "some argument", files: [{ uri: "file:///work/a.ts", name: "a.ts" }] },
    });
    await waitForIdle(client, s.id);
    const first = (await client.messages(s.id))[0];
    expect(first.type === "user" && first.text).toBe("/mock-init some argument");
  });

  it("replies to permissions and interrupts", async () => {
    const s = await client.createSession({});
    await client.prompt(s.id, "[permission] edit please");
    let perms = await client.permissions(s.id);
    for (let i = 0; i < 100 && perms.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      perms = await client.permissions(s.id);
    }
    expect(perms[0].action).toBe("edit");
    await client.replyPermission(s.id, perms[0].id, "once");
    expect(mock.requests.at(-1)?.body).toEqual({ decision: "once" });
    await waitForIdle(client, s.id);
    expect((await client.diff(s.id))[0].file).toBe("src/a.txt");
    expect(await client.interrupt(s.id)).toBe(true);
  });

  it("surfaces error messages from the server envelope", async () => {
    await expect(client.replyPermission("ses_missing", "per_x", "once")).rejects.toMatchObject({
      status: 404,
      tag: "SessionNotFoundError",
    });
  });
});

async function waitForIdle(client: OpenCodeClient, id: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const msgs = await client.messages(id);
    if (msgs.some((m) => m.type === "idle")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("session never became idle");
}
