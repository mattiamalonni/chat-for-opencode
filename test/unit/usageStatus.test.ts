import { describe, expect, it } from "vitest";

import { formatCost, usageLabel, usageTooltip, usageUpdateFromMessage } from "../../src/chat/usageStatus";
import type { TokenUsage } from "../../src/shared/api";

const tokens: TokenUsage = { input: 900, output: 50, reasoning: 0, cache: { read: 30, write: 20 } };
const usage = { cost: 0.12, tokens };

describe("usageUpdateFromMessage", () => {
  it("takes usage from a full session payload and from a delta", () => {
    expect(
      usageUpdateFromMessage({ type: "session", session: { id: "s", busy: false, messages: [], permissions: [], forms: [], usage } }),
    ).toEqual({
      kind: "set",
      usage,
    });
    expect(usageUpdateFromMessage({ type: "sessionDelta", delta: { sessionId: "s", messages: [], usage } })).toEqual({
      kind: "set",
      usage,
    });
  });

  it("clears on a closed session but keeps the last value when usage is merely absent", () => {
    expect(usageUpdateFromMessage({ type: "session", session: null })).toEqual({ kind: "clear" });
    expect(
      usageUpdateFromMessage({ type: "session", session: { id: "s", busy: false, messages: [], permissions: [], forms: [] } }),
    ).toEqual({ kind: "keep" });
    expect(usageUpdateFromMessage({ type: "sessionDelta", delta: { sessionId: "s", messages: [] } })).toEqual({ kind: "keep" });
    expect(usageUpdateFromMessage({ type: "connection", status: "connected" })).toEqual({ kind: "keep" });
  });
});

describe("usageLabel and formatCost", () => {
  it("formats small and large costs like the turn footer", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(0.12)).toBe("$0.12");
    expect(formatCost(Number.NaN)).toBe("$0");
  });

  it("shows compact context tokens plus the cost", () => {
    // 900 input + 50 output + 30 cache read + 20 cache write = 1000, formatted as 1K.
    expect(usageLabel(usage)).toBe("$(graph) 1K · $0.12");
    expect(usageLabel({ cost: 0, tokens })).toBe("$(graph) 1K");
    expect(usageLabel({ cost: 0.1, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })).toBe("$(graph) $0.10");
  });

  it("gives a detailed, translated tooltip", () => {
    const tip = usageTooltip(usage, (s) => `<${s}>`);
    expect(tip).toContain("<Session cost>: $0.12");
    expect(tip).toContain("<Tokens in context (estimate)>: 1,000");
    expect(tip).toContain("<Input>: 900");
    expect(tip).toContain("<Cache read>: 30");
    expect(tip).toContain("<Click to open the chat>");
  });
});
