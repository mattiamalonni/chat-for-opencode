import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerEvent } from "../../src/client/sse";
import { normalizeServerEvent } from "../../src/shared/adapter";

const FIXTURES = join(__dirname, "../fixtures");
const OPENAPI = JSON.parse(readFileSync(join(__dirname, "../../docs/openapi-2.2.7.json"), "utf8")) as {
  paths: Record<string, unknown>;
};

const recorded = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".jsonl"))
  .flatMap((name) =>
    readFileSync(join(FIXTURES, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown),
  );

/**
 * Deterministic half of the contract gate: the live suite needs a real server and provider and
 * stays opt-in, but these recorded 2.2.7 artifacts must always survive the wire adapter and keep
 * exposing every endpoint the client calls. Drift here fails CI on every platform and every run.
 */
describe("recorded OpenCode 2.2.7 contract", () => {
  it("has recorded event fixtures to check", () => {
    expect(recorded.length).toBeGreaterThan(500);
  });

  it("normalizes every recorded event without dropping one", () => {
    const dropped = recorded
      .map((raw) => normalizeServerEvent(parseServerEvent({ data: JSON.stringify(raw) })))
      .map((event, index) => (event ? undefined : JSON.stringify(recorded[index]).slice(0, 200)))
      .filter((value): value is string => value !== undefined);
    expect(dropped).toEqual([]);
  });

  it("keeps every endpoint the client relies on in the OpenAPI snapshot", () => {
    const required = [
      "/api/info",
      "/api/event",
      "/api/config",
      "/api/model",
      "/api/model/default",
      "/api/agent",
      "/api/skill",
      "/api/command",
      "/api/session",
      "/api/session/{sessionID}/message",
      "/api/session/{sessionID}/prompt",
      "/api/session/{sessionID}/revert/stage",
      "/api/session/{sessionID}/revert/commit",
      "/api/session/{sessionID}/inbox",
      "/api/session/{sessionID}/permission",
      "/api/session/{sessionID}/form",
      "/api/session/{sessionID}/diff",
    ];
    expect(required.filter((path) => !(path in OPENAPI.paths))).toEqual([]);
  });
});
