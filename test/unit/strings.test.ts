import { describe, expect, it } from "vitest";
import { estimateDataUrlTokens, formatTokens } from "../../src/shared/format";
import { format } from "../../src/shared/strings";

describe("strings", () => {
  it("formats placeholders", () => {
    expect(format("Retrying ({0}): {1}", 2, "rate limit")).toBe("Retrying (2): rate limit");
  });
});

describe("context estimates", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(8500)).toBe("8.5K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("estimates inline attachment tokens from the base64 payload only", () => {
    expect(estimateDataUrlTokens(undefined)).toBe(0);
    expect(estimateDataUrlTokens("file:///work/a.ts")).toBe(0);
    expect(estimateDataUrlTokens("data:text/plain;base64,QQ==")).toBe(1);
    expect(estimateDataUrlTokens("data:text/plain;base64," + "QQ==".repeat(400))).toBeGreaterThan(100);
  });
});
