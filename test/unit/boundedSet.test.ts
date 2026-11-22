import { describe, expect, it } from "vitest";
import { BoundedSet } from "../../src/shared/boundedSet";

describe("BoundedSet", () => {
  it("evicts the oldest entry when full and keeps recent ones", () => {
    const set = new BoundedSet<string>(3);
    for (const value of ["a", "b", "c"]) set.add(value);
    set.add("d");
    expect(set.has("a")).toBe(false);
    expect([...["b", "c", "d"]].every((v) => set.has(v))).toBe(true);
    expect(set.size).toBe(3);
  });

  it("does not reset the FIFO order when an existing value is re-added", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    set.add("b");
    set.add("a");
    set.add("c");
    expect(set.has("a")).toBe(false);
    expect(set.has("c")).toBe(true);
  });

  it("supports delete and clear", () => {
    const set = new BoundedSet<number>(2);
    set.add(1);
    set.add(2);
    expect(set.delete(1)).toBe(true);
    expect(set.has(1)).toBe(false);
    set.clear();
    expect(set.size).toBe(0);
  });
});
