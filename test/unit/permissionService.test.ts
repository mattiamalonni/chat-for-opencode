import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../src/client/http";

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { PermissionService } from "../../src/chat/permissionService";

function service(): PermissionService {
  const ctx = {
    workspaceState: { get: vi.fn(() => ({})), update: vi.fn(async () => {}) },
  } as unknown as vscode.ExtensionContext;
  return new PermissionService(ctx, () => undefined, () => {});
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
