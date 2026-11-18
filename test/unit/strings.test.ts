import { describe, expect, it } from "vitest";
import { format } from "../../src/shared/strings";

describe("strings", () => {
  it("formats placeholders", () => {
    expect(format("Retrying ({0}): {1}", 2, "rate limit")).toBe("Retrying (2): rate limit");
  });
});
