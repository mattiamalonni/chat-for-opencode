import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../src/client/http";
import type { SessionInfo } from "../../src/shared/api";
import { SessionOwnershipService } from "../../src/chat/sessionOwnership";

const asInfo = (id: string, directory: string, parentID?: string) => ({ id, parentID, location: { directory } }) as unknown as SessionInfo;

function setup(directory: string | undefined = "/work/a", sessionId: string | undefined = "s1") {
  const getSession = vi.fn(async (id: string) => asInfo(id, "/work/a"));
  const listSessions = vi.fn(async () => [asInfo("s2", "/work/a"), asInfo("other", "/work/b")]);
  const client = { getSession, listSessions } as unknown as OpenCodeClient;
  const service = new SessionOwnershipService(
    () => client,
    () => directory,
    () => sessionId,
    () => {},
  );
  return { service, getSession, listSessions };
}

describe("SessionOwnershipService", () => {
  it("owns the open session and children created from it", () => {
    const { service } = setup();
    service.learn(asInfo("s1", "/work/a"));
    service.learn({ sessionID: "child", parentID: "s1" });
    expect(service.owns("s1")).toBe(true);
    expect(service.owns("child")).toBe(true);
  });

  it("rejects sessions belonging to another workspace", () => {
    const { service } = setup();
    service.learn(asInfo("foreign", "/work/b"));
    expect(service.owns("foreign")).toBe(false);
  });

  it("resolves unknown ids once and keeps them for later events", async () => {
    const { service, getSession } = setup();
    expect(service.owns("late")).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(getSession).toHaveBeenCalledWith("late");
    expect(service.owns("late")).toBe(true);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("primes from this folder's session list", async () => {
    const { service, listSessions } = setup();
    await service.prime();
    expect(listSessions).toHaveBeenCalledWith(undefined, 100);
    expect(service.owns("s2")).toBe(true);
    expect(service.owns("other")).toBe(false);
  });
});
