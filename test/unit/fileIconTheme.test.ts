import { describe, expect, it } from "vitest";
import { FileIconThemeService, type FileIconThemeEnv, type LanguageContribution, type ThemeVariant } from "../../src/chat/fileIconTheme";

interface Fixture {
  themeId: string | undefined;
  variant: ThemeVariant;
  associations: Record<string, string>;
  languages: readonly LanguageContribution[];
  files: Record<string, string>;
}

function envOf(fixture: Fixture): { env: FileIconThemeEnv; reads: string[] } {
  const reads: string[] = [];
  const env: FileIconThemeEnv = {
    themeId: () => fixture.themeId,
    variant: () => fixture.variant,
    associations: () => fixture.associations,
    languages: () => fixture.languages,
    locate: (id) => (id === fixture.themeId ? { jsonPath: "/theme/theme.json", baseDir: "/theme" } : undefined),
    readFile: async (file) => {
      reads.push(file);
      const content = fixture.files[file];
      if (content === undefined) throw new Error(`missing fixture ${file}`);
      return Buffer.from(content, "utf8");
    },
  };
  return { env, reads };
}

const TYPESCRIPT: LanguageContribution = { id: "typescript", extensions: [".ts", ".tsx"], filenames: [] };

const FONT_THEME = JSON.stringify({
  fonts: [{ id: "seti", src: [{ path: "./seti.woff", format: "woff" }], size: "150%" }],
  iconDefinitions: {
    _ts: { fontCharacter: "\\E099", fontColor: "#519aba" },
    _ts_light: { fontCharacter: "\\E099", fontColor: "#498ba7" },
    _json: { fontCharacter: "\\E060", fontColor: "#cbcb41" },
    _default: { fontCharacter: "\\E001", fontColor: "#96b5b4" },
  },
  file: "_default",
  fileExtensions: { json: "_json" },
  languageIds: { typescript: "_ts", json: "_json" },
  light: { file: "_default", languageIds: { typescript: "_ts_light" } },
});

const SVG_THEME = JSON.stringify({
  iconDefinitions: {
    default: { iconPath: "./default.svg" },
    ts: { iconPath: "./ts.svg" },
    lock: { iconPath: "./lock.svg" },
    special: { iconPath: "./special.svg" },
  },
  file: "default",
  fileExtensions: { ts: "ts", lock: "lock" },
  fileNames: { "src/special.ts": "special" },
});

describe("file icon theme resolver", () => {
  it("uses the language id from installed language contributions for font glyphs", async () => {
    const { env } = envOf({
      themeId: "seti",
      variant: "dark",
      associations: {},
      languages: [TYPESCRIPT],
      files: { "/theme/theme.json": FONT_THEME, "/theme/seti.woff": "\u0000woff" },
    });
    const result = await new FileIconThemeService(env).resolve(["src/app.ts"]);
    expect(result.icons["src/app.ts"]).toMatchObject({
      kind: "font",
      fontFamily: "oc-file-icon-seti",
      glyph: String.fromCodePoint(0xe099),
      color: "#519aba",
      size: "150%",
    });
    expect(result.fonts["oc-file-icon-seti"].src).toBe(`data:font/woff;base64,${Buffer.from("\u0000woff").toString("base64")}`);
  });

  it("honors the light variant definitions", async () => {
    const { env } = envOf({
      themeId: "seti",
      variant: "light",
      associations: {},
      languages: [TYPESCRIPT],
      files: { "/theme/theme.json": FONT_THEME, "/theme/seti.woff": "\u0000woff" },
    });
    const result = await new FileIconThemeService(env).resolve(["src/main.ts"]);
    expect(result.icons["src/main.ts"]).toMatchObject({ glyph: String.fromCodePoint(0xe099), color: "#498ba7" });
  });

  it("lets files.associations override the language inferred from the extension", async () => {
    const { env } = envOf({
      themeId: "seti",
      variant: "dark",
      associations: { "*.ts": "json" },
      languages: [TYPESCRIPT],
      files: { "/theme/theme.json": FONT_THEME, "/theme/seti.woff": "\u0000woff" },
    });
    const result = await new FileIconThemeService(env).resolve(["src/app.ts"]);
    expect(result.icons["src/app.ts"]).toMatchObject({ glyph: String.fromCodePoint(0xe060), color: "#cbcb41" });
  });

  it("prefers a file name with a parent path segment over the extension", async () => {
    const { env } = envOf({
      themeId: "svg",
      variant: "dark",
      associations: {},
      languages: [],
      files: {
        "/theme/theme.json": SVG_THEME,
        "/theme/default.svg": "<svg/>",
        "/theme/ts.svg": "<svg>ts</svg>",
        "/theme/lock.svg": "<svg>lock</svg>",
        "/theme/special.svg": "<svg>special</svg>",
      },
    });
    const service = new FileIconThemeService(env);
    const result = await service.resolve(["src/special.ts", "src/other.ts", "yarn.lock", "README"]);
    expect(result.icons["src/special.ts"]).toEqual({ kind: "svg", src: `data:image/svg+xml;base64,${Buffer.from("<svg>special</svg>").toString("base64")}` });
    expect(result.icons["src/other.ts"]).toEqual({ kind: "svg", src: `data:image/svg+xml;base64,${Buffer.from("<svg>ts</svg>").toString("base64")}` });
    expect(result.icons["yarn.lock"]).toEqual({ kind: "svg", src: `data:image/svg+xml;base64,${Buffer.from("<svg>lock</svg>").toString("base64")}` });
    expect(result.icons["README"]).toEqual({ kind: "svg", src: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` });
  });

  it("falls back to the default icon and reports misses when icons are disabled", async () => {
    const { env } = envOf({ themeId: undefined, variant: "dark", associations: {}, languages: [], files: {} });
    const result = await new FileIconThemeService(env).resolve(["src/app.ts"]);
    expect(result.icons).toEqual({ "src/app.ts": null });
  });

  it("caches resolved themes and signals when the theme changes", async () => {
    const { env, reads } = envOf({
      themeId: "svg",
      variant: "dark",
      associations: {},
      languages: [],
      files: {
        "/theme/theme.json": SVG_THEME,
        "/theme/default.svg": "<svg/>",
        "/theme/ts.svg": "<svg>ts</svg>",
        "/theme/lock.svg": "<svg>lock</svg>",
        "/theme/special.svg": "<svg>special</svg>",
      },
    });
    const service = new FileIconThemeService(env);
    await service.resolve(["src/a.ts"]);
    await service.resolve(["src/a.ts"]);
    expect(reads.filter((f) => f === "/theme/theme.json")).toHaveLength(1);

    service.invalidate();
    const changed = await service.resolve(["src/a.ts"]);
    expect(changed.reset).toBe(true);
  });
});
