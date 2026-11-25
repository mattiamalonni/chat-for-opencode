import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient, type Connection } from "../../src/client/http";
import type { SdkHost } from "../../src/sdk/bridge";

/** Builds a Connection backed by a fake generated client: no HTTP, no SDK bundle in unit tests. */
function connection(api: Record<string, unknown>): Connection {
  return { key: "test", embedded: true, baseUrl: "in-process", api: api as unknown as SdkHost };
}

function group(...methods: string[]): Record<string, ReturnType<typeof vi.fn>> {
  return Object.fromEntries(methods.map((name) => [name, vi.fn()]));
}

describe("OpenCodeClient adapter over the SDK", () => {
  it("maps info and session CRUD to the generated groups", async () => {
    const api = {
      server: group("info"),
      session: group("create", "get", "update", "remove", "list"),
    };
    api.server.info.mockResolvedValue({ version: "2.4.1" });
    api.session.create.mockResolvedValue({ id: "ses_1" });
    api.session.get.mockResolvedValue({ id: "ses_1", title: "Renamed" });
    api.session.list.mockResolvedValue({ data: [{ id: "ses_1" }], cursor: {} });
    const client = OpenCodeClient.create(connection(api));

    expect((await client.info()).version).toBe("2.4.1");
    expect(await client.createSession({ directory: "/work", agent: "plan", model: { id: "m", providerID: "p" } })).toEqual({ id: "ses_1" });
    expect(api.session.create).toHaveBeenCalledWith({
      location: { directory: "/work" },
      agent: "plan",
      model: { id: "m", providerID: "p" },
      permissions: undefined,
    });
    expect((await client.listSessions("/work")).map((s) => s.id)).toEqual(["ses_1"]);
    expect(api.session.list).toHaveBeenCalledWith({
      directory: "/work",
      limit: 50,
      cursor: undefined,
      order: "desc",
      parentID: null,
    });
    await client.renameSession("ses_1", "Renamed");
    expect(api.session.update).toHaveBeenCalledWith({ sessionID: "ses_1", title: "Renamed" });
    expect((await client.getSession("ses_1")).title).toBe("Renamed");
    await client.deleteSession("ses_1");
    expect(api.session.remove).toHaveBeenCalledWith({ sessionID: "ses_1" });
  });

  it("omits empty permissions and honours the connection directory", async () => {
    const api = { session: group("create") };
    api.session.create.mockResolvedValue({ id: "ses_2" });
    const conn = connection(api);
    conn.directory = "/workspace";
    await OpenCodeClient.create(conn).createSession({ permissions: [] });
    expect(api.session.create).toHaveBeenCalledWith({
      location: { directory: "/workspace" },
      agent: undefined,
      model: undefined,
      permissions: undefined,
    });
  });

  it("follows session and message cursors without resending order", async () => {
    const api = {
      session: group("list"),
      message: group("list"),
    };
    api.session.list
      .mockResolvedValueOnce({ data: [{ id: "a" }, { id: "b" }], cursor: { next: "cur" } })
      .mockResolvedValueOnce({ data: [{ id: "c" }], cursor: {} });
    api.message.list
      .mockResolvedValueOnce({ data: [{ id: "m1" }], cursor: { next: "mcur" } })
      .mockResolvedValueOnce({ data: [{ id: "m2" }], cursor: {} });
    const client = OpenCodeClient.create(connection(api));

    const first = await client.listSessionsPage("/w", 2);
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe("cur");
    const second = await client.listSessionsPage("/w", 2, first.next);
    expect(second.items.map((s) => s.id)).toEqual(["c"]);
    expect(api.session.list.mock.calls[1][0]).toMatchObject({ cursor: "cur", order: undefined });
    expect((await client.messages("ses")).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(api.message.list.mock.calls[1][0]).toMatchObject({ cursor: "mcur", order: undefined });
  });

  it("maps prompt, command and delivery modes", async () => {
    const api = { session: group("prompt", "command") };
    api.session.prompt.mockResolvedValue({ id: "msg_1" });
    const client = OpenCodeClient.create(connection(api));
    const files = [{ uri: "file:///work/a.ts", name: "a.ts" }];
    expect(await client.prompt("ses", "hello", files, "steer")).toEqual({ id: "msg_1" });
    expect(api.session.prompt).toHaveBeenCalledWith({ sessionID: "ses", text: "hello", files, delivery: "steer" });
    await client.command("ses", "init", "arg", files, "queue");
    expect(api.session.command).toHaveBeenCalledWith({ sessionID: "ses", name: "init", text: "arg", files, delivery: "queue" });
  });

  it("unwraps catalog envelopes", async () => {
    const api = {
      model: group("list", "default"),
      agent: group("list"),
      skill: group("list"),
      command: group("list"),
    };
    api.model.list.mockResolvedValue({ location: {}, data: [{ id: "fast" }] });
    api.model.default.mockResolvedValue({ location: {}, data: { id: "fast" } });
    api.agent.list.mockResolvedValue({ location: {}, data: [{ id: "build" }] });
    api.skill.list.mockResolvedValue({ location: {}, data: [{ id: "review" }] });
    api.command.list.mockResolvedValue({ location: {}, data: [{ name: "init" }] });
    const client = OpenCodeClient.create(connection(api));
    expect((await client.models()).map((m) => m.id)).toEqual(["fast"]);
    expect(api.model.list).toHaveBeenCalledWith({ types: ["chat"], location: undefined });
    expect((await client.defaultModel())?.id).toBe("fast");
    expect((await client.agents()).map((a) => a.id)).toEqual(["build"]);
    expect((await client.skills()).map((s) => s.id)).toEqual(["review"]);
    expect((await client.commands()).map((c) => c.name)).toEqual(["init"]);
  });

  it("maps permissions, forms, inbox, diff and revert", async () => {
    const inbox = group("list", "update", "cancel");
    const revert = group("stage", "commit", "clear");
    const form = group("list", "reply", "cancel");
    const session = { form, inbox, revert, diff: vi.fn(), wait: vi.fn(), interrupt: vi.fn() };
    const api = { permission: group("list", "reply"), session };
    api.permission.list.mockResolvedValue([{ id: "per_1" }]);
    form.list.mockResolvedValue([{ id: "form_1" }]);
    inbox.list.mockResolvedValue([{ id: "in_1", delivery: "queue" }]);
    session.diff.mockResolvedValue([{ file: "a.ts", patch: "+" }]);
    session.wait.mockResolvedValue(undefined);
    session.interrupt.mockResolvedValue({ interrupted: true });
    const client = OpenCodeClient.create(connection(api));

    expect((await client.permissions("ses")).map((p) => p.id)).toEqual(["per_1"]);
    await client.replyPermission("ses", "per_1", "once");
    expect(api.permission.reply).toHaveBeenCalledWith({ sessionID: "ses", requestID: "per_1", decision: "once" });
    expect((await client.forms("ses"))[0].id).toBe("form_1");
    await client.replyForm("ses", "form_1", { answer: "yes" });
    expect(form.reply).toHaveBeenCalledWith({ sessionID: "ses", formID: "form_1", answer: { answer: "yes" } });
    expect((await client.inbox("ses"))[0].delivery).toBe("queue");
    await client.setInboxDelivery("ses", "in_1", "steer");
    expect(inbox.update).toHaveBeenCalledWith({ sessionID: "ses", inboxID: "in_1", delivery: "steer" });
    expect((await client.diff("ses"))[0].file).toBe("a.ts");
    await client.waitIdle("ses");
    await client.revertStage("ses", "msg_1", false);
    expect(revert.stage).toHaveBeenCalledWith({ sessionID: "ses", messageID: "msg_1", files: false });
    await client.revertCommit("ses");
    await client.revertClear("ses");
    expect(await client.interrupt("ses")).toBe(true);
  });

  it("unwraps OAuth attempts and projects credentials without secrets", async () => {
    const api = {
      integration: { ...group("list", "get"), oauth: group("connect", "status"), connect: group("key") },
      credential: group("list", "update", "remove", "activate"),
    };
    api.integration.oauth.connect.mockResolvedValue({ location: {}, data: { id: "att_1" } });
    api.integration.oauth.status.mockResolvedValue({ location: {}, data: { status: "ok" } });
    api.credential.list.mockResolvedValue([
      { id: "c1", integrationID: "github", label: "GitHub", active: true, value: { type: "oauth", token: "SECRET" } },
      { id: "c2", integrationID: "bad", label: "Bad", active: true, value: { type: "unknown" } },
    ]);
    const client = OpenCodeClient.create(connection(api));
    expect(await client.startOAuth("github", "device", {}, "laptop", "/w")).toEqual({ id: "att_1" } as never);
    expect(await client.oauthStatus("github", "att_1", "/w")).toEqual({ status: "ok" } as never);
    expect(await client.credentials()).toEqual([{ id: "c1", integrationID: "github", label: "GitHub", active: true, type: "oauth" }]);
    expect(JSON.stringify(await client.credentials())).not.toContain("SECRET");
  });

  it("converts SDK failures into ApiError", async () => {
    const api = { session: group("get") };
    api.session.get.mockRejectedValue({ status: 404, _tag: "SessionNotFoundError", message: "missing" });
    await expect(OpenCodeClient.create(connection(api)).getSession("nope")).rejects.toMatchObject({
      status: 404,
      tag: "SessionNotFoundError",
      message: "missing",
    });
  });

  it("forwards live events and reports stream end", async () => {
    const api = { event: group("subscribe") };
    api.event.subscribe.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.idle", data: { sessionID: "ses" }, location: { directory: "/w" } };
      },
    }));
    const client = OpenCodeClient.create(connection(api));
    const events: unknown[] = [];
    const closed = vi.fn();
    client.subscribe((e) => events.push(e), closed, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toMatchObject([{ type: "session.idle" }]);
    expect(closed).toHaveBeenCalled();
  });
});
