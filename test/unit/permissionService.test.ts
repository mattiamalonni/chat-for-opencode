import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../src/client/http";

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { PermissionService } from "../../src/chat/permissionService";

function service(log: (line: string) => void = () => {}): PermissionService {
  const ctx = {
    workspaceState: { get: vi.fn(() => ({})), update: vi.fn(async () => {}) },
  } as unknown as vscode.ExtensionContext;
  return new PermissionService(ctx, () => undefined, log);
}

function deferredClient(): { client: OpenCodeClient; calls: () => number; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const replyPermission = vi.fn(
    () =>
      new Promise<void>((res, rej) => {
        resolve = () => res();
        reject = rej;
      }),
  );
  return {
    client: { replyPermission } as unknown as OpenCodeClient,
    calls: () => replyPermission.mock.calls.length,
    resolve: () => resolve(),
    reject: (err) => reject(err),
  };
}

describe("PermissionService.approveOnce", () => {
  it("shares one in-flight reply and retries after a failure", async () => {
    const permissions = service();
    const { client, calls, reject, resolve } = deferredClient();

    const first = permissions.approveOnce(client, "s", "p1");
    const second = permissions.approveOnce(client, "s", "p1");
    expect(calls()).toBe(1);

    reject(new Error("network down"));
    // Both callers must observe the real failure, not an optimistic `true`.
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

    const third = permissions.approveOnce(client, "s", "p1");
    expect(calls()).toBe(2);
    resolve();
    await expect(third).resolves.toBe(true);
  });

  it("caps the remembered grant set so ids cannot accumulate without bound", async () => {
    const permissions = service();
    const replyPermission = vi.fn(async () => {});
    const client = { replyPermission } as unknown as OpenCodeClient;
    for (let i = 0; i < 500; i++) await permissions.approveOnce(client, "s", `p${i}`);
    expect(replyPermission).toHaveBeenCalledTimes(500);
    // The next grant evicts the oldest id (p0); a recent one must still be remembered.
    await permissions.approveOnce(client, "s", "p500");
    await permissions.approveOnce(client, "s", "p0");
    await permissions.approveOnce(client, "s", "p499");
    expect(replyPermission).toHaveBeenCalledTimes(502);
  });

  it("remembers a successful grant so later callers skip the reply", async () => {
    const permissions = service();
    const { client, calls, resolve } = deferredClient();

    const first = permissions.approveOnce(client, "s", "p1");
    const second = permissions.approveOnce(client, "s", "p1");
    resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await permissions.approveOnce(client, "s", "p1")).toBe(true);
    expect(calls()).toBe(1);
  });

  it("keys auto-approvals by session so a colliding request id is not treated as granted", async () => {
    const permissions = service();
    const { client, calls, resolve } = deferredClient();

    const first = permissions.approveOnce(client, "sessionA", "p1");
    resolve();
    expect(await first).toBe(true);

    // Same request id, different session: a fresh reply is required.
    const other = permissions.approveOnce(client, "sessionB", "p1");
    expect(calls()).toBe(2);
    resolve();
    expect(await other).toBe(true);
  });

  it("does not share an in-flight promise across sessions", async () => {
    const permissions = service();
    const replyPermission = vi.fn(async () => {});
    const client = { replyPermission } as unknown as OpenCodeClient;

    await Promise.all([
      permissions.approveOnce(client, "sessionA", "shared"),
      permissions.approveOnce(client, "sessionB", "shared"),
    ]);

    expect(replyPermission).toHaveBeenCalledTimes(2);
    expect(replyPermission).toHaveBeenCalledWith("sessionA", "shared", "once");
    expect(replyPermission).toHaveBeenCalledWith("sessionB", "shared", "once");
  });

  it("logs the composite session/request key on failure", async () => {
    const log = vi.fn();
    const permissions = service(log);
    const client = { replyPermission: vi.fn(async () => { throw new Error("nope"); }) } as unknown as OpenCodeClient;

    expect(await permissions.approveOnce(client, "sessionA", "p1")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sessionA:p1"));
  });
});

describe("PermissionService.forgetRequest", () => {
  function countingClient(): { client: OpenCodeClient; calls: () => number } {
    const replyPermission = vi.fn(async () => {});
    return { client: { replyPermission } as unknown as OpenCodeClient, calls: () => replyPermission.mock.calls.length };
  }

  it("without a sessionId, removes every session's entry for that request id", async () => {
    const permissions = service();
    const { client, calls } = countingClient();

    await permissions.approveOnce(client, "sessionA", "p1");
    await permissions.approveOnce(client, "sessionB", "p1");
    await permissions.approveOnce(client, "sessionA", "p2");
    expect(calls()).toBe(3);

    permissions.forgetRequest("p1");

    await permissions.approveOnce(client, "sessionA", "p1");
    await permissions.approveOnce(client, "sessionB", "p1");
    await permissions.approveOnce(client, "sessionA", "p2");
    // Both p1 grants were forgotten (two new replies); the unrelated p2 grant was kept.
    expect(calls()).toBe(5);
  });

  it("with a sessionId, removes only that session's exact entry", async () => {
    const permissions = service();
    const { client, calls } = countingClient();

    await permissions.approveOnce(client, "sessionA", "p1");
    await permissions.approveOnce(client, "sessionB", "p1");

    permissions.forgetRequest("p1", "sessionA");

    await permissions.approveOnce(client, "sessionA", "p1");
    await permissions.approveOnce(client, "sessionB", "p1");
    // Only sessionA re-replied; sessionB's grant survived.
    expect(calls()).toBe(3);
  });
});

describe("PermissionService.filterPending", () => {
  it("uses the caller's decision instead of re-checking the child session's own override", async () => {
    const permissions = service();
    const replyPermission = vi.fn(async () => {});
    const client = { replyPermission } as unknown as OpenCodeClient;
    const request = { id: "p1" } as Parameters<PermissionService["filterPending"]>[2][number];

    // A child has no override and the global default is off: the plain gate keeps the card.
    expect(await permissions.filterPending(client, "child", [request])).toEqual([request]);
    expect(replyPermission).not.toHaveBeenCalled();

    // The parent's explicit auto-approve decision grants it, still addressed to the child.
    expect(await permissions.filterPending(client, "child", [request], true)).toEqual([]);
    expect(replyPermission).toHaveBeenCalledWith("child", "p1", "once");
  });
});
