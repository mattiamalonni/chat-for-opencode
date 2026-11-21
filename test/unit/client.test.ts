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

  it("honors queue/steer delivery when running a slash command", async () => {
    const s = await client.createSession({});
    await client.command(s.id, "mock-init", "queued", [], "queue");
    expect(mock.requests.at(-1)?.body).toMatchObject({ name: "mock-init", text: "queued", delivery: "queue" });
    await client.command(s.id, "mock-init", "now", [], "steer");
    expect(mock.requests.at(-1)?.body).toMatchObject({ name: "mock-init", text: "now", delivery: "steer" });
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

  it("caps an oversized error body before it can reach the chat UI", async () => {
    const huge = "x".repeat(50_000);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: huge }), { status: 500 })) as typeof fetch;
    const bounded = new OpenCodeClient({ baseUrl: "http://localhost:1", password: "secret" }, fetchImpl);
    let error: ApiError | undefined;
    try {
      await bounded.info();
    } catch (err) {
      error = err as ApiError;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.message.length).toBeLessThanOrEqual(4000);
  });

  it("stages and commits a revert at any message, and can clear a staged one", async () => {
    const s = await client.createSession({});
    await client.prompt(s.id, "first");
    await waitForIdle(client, s.id);
    await client.prompt(s.id, "second");
    for (let i = 0; i < 300; i++) {
      if ((await client.messages(s.id)).filter((m) => m.type === "idle").length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const before = await client.messages(s.id);
    const firstUser = before.find((m) => m.type === "user")!;
    expect(before.filter((m) => m.type === "user")).toHaveLength(2);

    await client.waitIdle(s.id);
    expect(mock.requests.at(-1)?.path).toBe(`/api/experimental/session/${s.id}/wait`);

    // An intermediate boundary drops that turn and everything after it, not just the last one.
    await client.revertStage(s.id, firstUser.id, false);
    expect(mock.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/session/${s.id}/revert/stage`,
      body: { messageID: firstUser.id, files: false },
    });
    expect(mock.sessions.get(s.id)!.info.revert).toMatchObject({ messageID: firstUser.id });

    await client.revertCommit(s.id);
    expect(mock.requests.at(-1)?.path).toBe(`/api/session/${s.id}/revert/commit`);
    expect(await client.messages(s.id)).toHaveLength(0);
    expect(mock.sessions.get(s.id)!.info.revert).toBeUndefined();

    // Without `files` the body only carries the message id; clearing keeps the history intact.
    await client.prompt(s.id, "third");
    await waitForIdle(client, s.id);
    const third = (await client.messages(s.id)).find((m) => m.type === "user")!;
    await client.revertStage(s.id, third.id);
    expect(mock.requests.at(-1)?.body).toEqual({ messageID: third.id });
    await client.revertClear(s.id);
    expect(mock.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/api/session/${s.id}/revert` });
    expect(mock.sessions.get(s.id)!.info.revert).toBeUndefined();
    expect((await client.messages(s.id)).some((m) => m.id === third.id)).toBe(true);
  });

  it("forks history before a message without touching the original session", async () => {
    const s = await client.createSession({});
    await client.prompt(s.id, "first");
    await waitForIdle(client, s.id);
    await client.prompt(s.id, "second");
    await waitForIdle(client, s.id);
    const all = await client.messages(s.id);
    const secondUser = all.find((m, i) => m.type === "user" && all.slice(0, i).some((p) => p.type === "user"))!;
    const fork = await client.forkSession(s.id, secondUser.id);
    expect(mock.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/session/${s.id}/fork`,
      body: { before: secondUser.id },
    });
    expect(fork.id).not.toBe(s.id);
    const texts = (await client.messages(fork.id)).filter((m) => m.type === "user").map((m) => (m.type === "user" ? m.text : ""));
    expect(texts).toEqual(["first"]);
    expect((await client.messages(s.id)).filter((m) => m.type === "user")).toHaveLength(2);
  });

  it("lists, promotes and cancels pending inbox items", async () => {
    const s = await client.createSession({});
    const item = {
      id: "msg_queued",
      sessionID: s.id,
      time: { created: 1 },
      type: "user",
      delivery: "queue",
      payload: { text: "queued prompt" },
    };
    await fetch(`${mock.url}/__mock/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID: s.id, items: [item] }),
    });
    expect(await client.inbox(s.id)).toEqual([item]);
    await client.setInboxDelivery(s.id, item.id, "steer");
    expect(mock.requests.at(-1)).toMatchObject({
      method: "PATCH",
      path: `/api/session/${s.id}/inbox/${item.id}`,
      body: { delivery: "steer" },
    });
    expect((await client.inbox(s.id))[0].delivery).toBe("steer");
    await client.cancelInbox(s.id, item.id);
    expect(mock.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/api/session/${s.id}/inbox/${item.id}` });
    expect(await client.inbox(s.id)).toEqual([]);
  });
});

describe("OpenCodeClient at the trust boundary", () => {
  const fetchText = (text: string, status = 200): typeof fetch => async () => new Response(text, { status });

  it("turns a malformed 200 body into an ApiError instead of a SyntaxError", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost/" }, fetchText("<html>proxy error</html>"));
    await expect(client.info()).rejects.toMatchObject({ status: 200, tag: "malformedResponse" });
  });

  it("rejects a missing data envelope and a wrong list shape", async () => {
    const missing = new OpenCodeClient({ baseUrl: "http://localhost/" }, fetchText('{"version":"2.2.7"}'));
    await expect(missing.listSessions()).rejects.toMatchObject({ status: 200, tag: "malformedResponse" });
    const wrong = new OpenCodeClient({ baseUrl: "http://localhost/" }, fetchText('{"data":"not-an-array"}'));
    await expect(wrong.inbox("s1")).rejects.toMatchObject({ status: 200, tag: "malformedResponse" });
  });

  it("still accepts an empty body for void endpoints", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://localhost/" }, fetchText(""));
    await expect(client.compact("s1")).resolves.toBeUndefined();
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
