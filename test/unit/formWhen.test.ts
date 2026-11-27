import { describe, expect, it } from "vitest";
import type { FormField } from "../../src/shared/api";
import { fieldApplies } from "../../src/shared/formWhen";

const field = (when?: FormField["when"]): FormField => ({ key: "f", type: "string", when });

describe("fieldApplies", () => {
  it("applies a field without rules", () => {
    expect(fieldApplies(field(), {})).toBe(true);
  });

  it("requires every eq/neq rule to hold, treating a missing answer as empty", () => {
    const f = field([
      { key: "deploy", op: "eq", value: "yes" },
      { key: "region", op: "neq", value: "" },
    ]);
    expect(fieldApplies(f, { deploy: "yes", region: "eu" })).toBe(true);
    expect(fieldApplies(f, { deploy: "yes" })).toBe(false);
    expect(fieldApplies(f, { deploy: "no", region: "eu" })).toBe(false);
  });

  it("compares booleans and numbers strictly", () => {
    expect(fieldApplies(field([{ key: "on", op: "eq", value: true }]), { on: true })).toBe(true);
    expect(fieldApplies(field([{ key: "on", op: "eq", value: true }]), { on: "true" })).toBe(false);
    expect(fieldApplies(field([{ key: "n", op: "eq", value: 3 }]), { n: 3 })).toBe(true);
  });
});
