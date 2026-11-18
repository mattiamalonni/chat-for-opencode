import { describe, expect, it } from "vitest";
import { evictableKey } from "../../src/shared/diffCache";

describe("virtual diff cache eviction", () => {
  const contents = new Map([
    ["doc1", "a"],
    ["doc2", "b"],
    ["doc3", "c"],
  ]);

  it("evicts the oldest entry that is not open", () => {
    expect(evictableKey(contents, new Set(["doc1"]))).toBe("doc2");
    expect(evictableKey(contents, new Set(["doc2"]))).toBe("doc1");
  });

  it("returns nothing when every cached document is still open", () => {
    expect(evictableKey(contents, new Set(["doc1", "doc2", "doc3"]))).toBeUndefined();
  });

  it("ignores unrelated open documents", () => {
    expect(evictableKey(contents, new Set(["file:///work/a.ts"]))).toBe("doc1");
  });
});
