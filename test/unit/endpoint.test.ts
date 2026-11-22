import { describe, expect, it } from "vitest";
import { normalizeEndpoint } from "../../src/server/endpoint";

describe("external endpoint normalization", () => {
  it("strips userinfo and keeps it as a password fallback", () => {
    const normalized = normalizeEndpoint("https://user:my-secret@opencode.example.com:8443/api/");
    expect(normalized.baseUrl).toBe("https://opencode.example.com:8443/api");
    expect(normalized.baseUrl).not.toContain("my-secret");
    expect(normalized.password).toBe("my-secret");
  });

  it("leaves a plain endpoint untouched", () => {
    expect(normalizeEndpoint("http://127.0.0.1:4096")).toEqual({ baseUrl: "http://127.0.0.1:4096", password: undefined });
  });

  it("redacts userinfo even when the URL cannot be parsed", () => {
    const normalized = normalizeEndpoint("not a url://user:token@host");
    expect(normalized.baseUrl).not.toContain("token");
  });
});
