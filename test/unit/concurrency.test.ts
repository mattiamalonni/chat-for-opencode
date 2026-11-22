import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/shared/concurrency";

describe("bounded async mapping", () => {
  it("keeps at most `limit` tasks in flight and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(n);
      await new Promise((r) => setTimeout(r, n % 2 === 0 ? 5 : 1));
      active--;
      return n * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
    expect(seen).toHaveLength(8);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 5, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 20, async (x) => x + 1)).toEqual([2, 3]);
  });
});
