import { describe, expect, it } from "vitest";
import { checkContract, contractSignature, emptyContract, type ContractObservations } from "../../src/shared/contract";

const model = { id: "m1", limit: { context: 200_000 } };
const agent = { id: "build" };
const skill = { id: "review" };
const message = { type: "user", time: { created: 1 } };

function healthy(): ContractObservations {
  return { version: "2.4.0", models: [model], agents: [agent], skills: [skill], messages: [message] };
}

function ids(report: ReturnType<typeof checkContract>): string[] {
  return report.failures.map((f) => f.id);
}

describe("checkContract", () => {
  it("reports the mandatory capabilities on an empty observation set", () => {
    const report = checkContract({});
    expect(ids(report)).toEqual(["serverInfo", "models", "agents", "skills", "history"]);
    expect(report.checked).toBe(5);
  });

  it("passes a healthy 2.4.0-shaped observation set", () => {
    const report = checkContract(healthy());
    expect(report.failures).toEqual([]);
    expect(report.checked).toBe(6); // contextMeter is checked when models are present
  });

  it("accepts empty catalogs but flags a malformed entry", () => {
    const report = checkContract({ ...healthy(), agents: [{ name: "no id" }], skills: [] });
    expect(ids(report)).toEqual(["agents"]);
  });

  it("only checks the context meter when models exist", () => {
    expect(ids(checkContract({ ...healthy(), models: [] }))).toEqual([]);
    expect(ids(checkContract({ ...healthy(), models: [{ id: "m1" }] }))).toEqual(["contextMeter"]);
  });

  it("checks changed files and inbox only when present", () => {
    expect(ids(checkContract(healthy()))).toEqual([]);
    expect(ids(checkContract({ ...healthy(), diff: [], inbox: [] }))).toEqual([]);
    expect(ids(checkContract({ ...healthy(), diff: [{ file: "a.ts" }] }))).toEqual(["changedFiles"]);
    expect(ids(checkContract({ ...healthy(), inbox: [{ id: "i1", type: "user", delivery: "later" }] }))).toEqual(["inbox"]);
  });

  it("validates the history shape (type and time.created)", () => {
    const report = checkContract({ ...healthy(), messages: [{ type: "user", time: {} }] });
    expect(ids(report)).toEqual(["history"]);
  });

  it("builds a stable, sorted dismissal signature", () => {
    expect(contractSignature(emptyContract)).toBe("ok");
    expect(contractSignature(checkContract(healthy()))).toBe("ok");
    const a = checkContract({ ...healthy(), diff: [{ file: 1 }], agents: [{ name: "no id" }] });
    const b = checkContract({ ...healthy(), agents: [{ name: "no id" }], diff: [{ file: 1 }] });
    expect(contractSignature(a)).toBe("agents,changedFiles");
    expect(contractSignature(b)).toBe(contractSignature(a));
  });
});
