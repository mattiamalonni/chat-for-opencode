import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerEvent } from "../../src/client/sse";
import { REQUIRED_ENDPOINTS } from "../../src/client/endpoints";
import { normalizeServerEvent } from "../../src/shared/adapter";

const FIXTURES = join(__dirname, "../fixtures");
const OPENAPI = JSON.parse(readFileSync(join(__dirname, "../../docs/openapi-2.4.1.json"), "utf8")) as {
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
 * exposing every endpoint the client calls (checked against the 2.4.1 OpenAPI snapshot). Drift here
 * fails CI on every platform and every run.
 */
describe("recorded OpenCode 2.2.7 contract against the 2.4.1 snapshot", () => {
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

  it("keeps every endpoint and method the client relies on in the OpenAPI snapshot", () => {
    // The registry is what OpenCodeClient.requestEndpoint uses, so a new call cannot escape the gate.
    const missing = REQUIRED_ENDPOINTS.flatMap((endpoint) => {
      const path = `/${endpoint.path}`;
      const item = OPENAPI.paths[path] as Record<string, unknown> | undefined;
      if (!item) return [path];
      return endpoint.method.toLowerCase() in item ? [] : [`${endpoint.method} ${path}`];
    });
    expect(missing).toEqual([]);
    expect(REQUIRED_ENDPOINTS.length).toBeGreaterThanOrEqual(30);
  });
});
