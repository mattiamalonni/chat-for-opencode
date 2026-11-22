import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/server/redact";

const SECRET = "s3cr3t-value-with-dashes_123";

describe("server credential redaction", () => {
  it("redacts the raw password and its Basic auth encodings", () => {
    const basic = Buffer.from(`opencode:${SECRET}`, "utf8").toString("base64");
    const basicUrl = Buffer.from(`opencode:${SECRET}`, "utf8").toString("base64url");
    const line = `env OPENCODE_PASSWORD=${SECRET} authorization: Basic ${basic} urlencoded=${encodeURIComponent(SECRET)} hex=${Buffer.from(SECRET).toString("hex")}`;
    const out = redactSecrets(line, SECRET);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(basic);
    expect(out).not.toContain(basicUrl);
    expect(out).not.toContain(encodeURIComponent(SECRET));
    expect(out).not.toContain(Buffer.from(SECRET).toString("hex"));
    expect(out).toContain("OPENCODE_PASSWORD=");
    expect(out).toContain("authorization: Basic ***");
  });

  it("redacts credentials whose value it never sees (external server)", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toContain("Basic ***");
    expect(redactSecrets('{"headers":{"authorization":"Basic abcdefghijkl"}}')).not.toContain("abcdefghijkl");
    expect(redactSecrets("server password abcdefghijklmnop")).toBe("server password ***");
    expect(redactSecrets("Bearer eyJhbGciOiJIUzI1NiJ9.payload")).toContain("Bearer ***");
    expect(redactSecrets("Authorization: Basic short", SECRET)).toContain("Basic short");
  });

  it("keeps ordinary output untouched and handles empty input", () => {
    expect(redactSecrets("listening on http://127.0.0.1:1234", SECRET)).toBe("listening on http://127.0.0.1:1234");
    expect(redactSecrets("", SECRET)).toBe("");
    expect(redactSecrets(undefined as unknown as string)).toBe("");
  });
});
