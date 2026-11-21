import { describe, expect, it, vi } from "vitest";
import { ChatLifecycle } from "../../src/chat/lifecycle";

describe("ChatLifecycle", () => {
  it("keeps one token per concern and invalidates only that concern", () => {
    const life = new ChatLifecycle();
    const load = life.generations.load.bump();
    const connect = life.generations.connect.bump();

    expect(life.generations.load.is(load)).toBe(true);
    life.generations.load.bump();
    expect(life.generations.load.is(load)).toBe(false);
    expect(life.generations.connect.is(connect)).toBe(true);
  });

  it("re-scheduling a named task cancels the previous one", () => {
    vi.useFakeTimers();
    try {
      const life = new ChatLifecycle();
      const first = vi.fn();
      const second = vi.fn();
      life.schedule("sessions", first, 100);
      life.schedule("sessions", second, 100);
      vi.advanceTimersByTime(100);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearAll cancels both timeouts and intervals", () => {
    vi.useFakeTimers();
    try {
      const life = new ChatLifecycle();
      const timeout = vi.fn();
      const interval = vi.fn();
      life.schedule("reconcile", timeout, 50);
      expect(life.startInterval("livePoll", interval, 50)).toBe(true);
      expect(life.startInterval("livePoll", interval, 50)).toBe(false);
      expect(life.hasInterval("livePoll")).toBe(true);

      life.clearAll();
      expect(life.hasInterval("livePoll")).toBe(false);
      vi.advanceTimersByTime(200);
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
