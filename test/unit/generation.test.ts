import { describe, expect, it } from "vitest";
import { Generation } from "../../src/chat/generation";

describe("Generation", () => {
  it("starts at zero and bumps monotonically", () => {
    const g = new Generation();
    expect(g.current()).toBe(0);
    expect(g.bump()).toBe(1);
    expect(g.bump()).toBe(2);
    expect(g.current()).toBe(2);
  });

  it("invalidates previously issued tokens", () => {
    const g = new Generation();
    const first = g.bump();
    expect(g.is(first)).toBe(true);
    g.bump();
    expect(g.is(first)).toBe(false);
    expect(g.is(g.current())).toBe(true);
  });
});
