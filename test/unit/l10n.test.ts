import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STRINGS, format } from "../../src/shared/strings";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(root, p)).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("localization", () => {
  const it_ = JSON.parse(read("l10n/bundle.l10n.it.json")) as Record<string, string>;

  it("translates every webview string and every vscode.l10n.t literal into Italian", () => {
    const literals = sources("src").flatMap((f) => [...read(f).matchAll(/l10n\.t\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string));
    const missing = [...Object.values(STRINGS), ...literals].filter((s) => !(s in it_));
    expect(missing).toEqual([]);
  });

  it("keeps placeholders in translations", () => {
    for (const [en, it] of Object.entries(it_)) {
      expect((it.match(/\{\d\}/g) ?? []).sort(), en).toEqual((en.match(/\{\d\}/g) ?? []).sort());
    }
  });

  it("defines every %key% of package.json in both manifest translations", () => {
    const keys = [...read("package.json").matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]);
    for (const file of ["package.nls.json", "package.nls.it.json"]) {
      const nls = JSON.parse(read(file)) as Record<string, string>;
      expect(keys.filter((k) => !(k in nls)), file).toEqual([]);
    }
  });

  it("formats placeholders", () => {
    expect(format("Retrying ({0}): {1}", 2, "rate limit")).toBe("Retrying (2): rate limit");
  });
});
