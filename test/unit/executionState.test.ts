import { describe, expect, it } from "vitest";
import { ExecutionStateService } from "../../src/chat/executionState";

describe("ExecutionStateService — one owner for turn state", () => {
  it("publishes to subscribers and invalidates older turns on start", () => {
    const service = new ExecutionStateService();
    const seen: string[] = [];
    service.onDidChange((s) => seen.push(s.status));
    const first = service.start("s1");
    expect(seen).toEqual(["idle", "running"]);
    expect(service.state).toEqual({ status: "running", sessionId: "s1" });

    const second = service.start("s1");
    expect(service.is(first)).toBe(false);
    expect(second).toBeGreaterThan(first);
    service.fail("s1", first);
    expect(service.state.status).toBe("running");
  });

  it("derives transitions from normalized server events and returns terminal status once", () => {
    const service = new ExecutionStateService();
    expect(service.observe("session.execution.started", "s1", "s1")).toBeUndefined();
    expect(service.state.status).toBe("running");
    expect(service.observe("session.inbox.enqueued", "s1", "s1")).toBeUndefined();
    expect(service.state.status).toBe("running");
    expect(service.observe("session.execution.succeeded", "s1", "s1")).toBe("succeeded");
    expect(service.state.status).toBe("succeeded");
    expect(service.observe("session.execution.failed", "other", "s1")).toBeUndefined();
    expect(service.state.status).toBe("succeeded");
  });

  it("tracks a local idle with the same generation the resync guard uses", () => {
    const service = new ExecutionStateService();
    const token = service.start("s1");
    expect(service.markLocalIdle("s1", token)).toBe(true);
    expect(service.state.status).toBe("idle");
    expect(service.isLocallyIdle("s1")).toBe(true);
    service.observe("session.execution.started", "s1", "s1");
    expect(service.isLocallyIdle("s1")).toBe(false);
    expect(service.markLocalIdle("s1", token)).toBe(false);
  });

  it("reset invalidates in-flight work and clears a stale running badge", () => {
    const service = new ExecutionStateService();
    const token = service.start("s1");
    service.reset();
    expect(service.is(token)).toBe(false);
    expect(service.isLocallyIdle("s1")).toBe(false);
    expect(service.state.status).toBe("idle");
  });
});
