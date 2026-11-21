/**
 * Resolves file icons from the user's active VS Code file icon theme.
 *
 * VS Code does not expose "the themed icon for this file" to extensions: `ThemeIcon.File` only
 * works in views VS Code renders itself (tree, quick pick, timeline). So we read the theme that
 * the user selected, apply the same association rules documented for `contributes.iconThemes`,
 * and ship the resulting SVG/font glyph to the webview as a data URI.
 */
import * as path from "node:path";
import type { FileIconData, FileIconFont } from "../shared/protocol";

export type ThemeVariant = "dark" | "light" | "highContrast";

interface IconPathValue {
  iconPath: string;
  light?: string;
  dark?: string;
  highContrast?: string;
}

interface IconDefinition {
  iconPath?: string | IconPathValue;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

interface FontDefinition {
  id?: string;
  src: Array<{ path: string; format?: string }>;
  weight?: string;
  style?: string;
  size?: string;
}

/** The association properties a theme (or one of its variants) can define. */
interface Associations {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: FontDefinition[];
}

interface ThemeFile extends Associations {
  extends?: string;
  light?: Associations;
  highContrast?: Associations;
}

export interface LanguageContribution {
  id: string;
  extensions?: string[];
  filenames?: string[];
}

/** Everything host-specific, injected so the resolver can be tested without VS Code. */
export interface FileIconThemeEnv {
  /** Value of `workbench.iconTheme`; `undefined` when icons are disabled. */
  themeId(): string | undefined;
  variant(): ThemeVariant;
  /** `files.associations`, which overrides the language inferred from the file name. */
  associations(): Record<string, string>;
  languages(): readonly LanguageContribution[];
  locate(themeId: string): { jsonPath: string; baseDir: string } | undefined;
  readFile(path: string): PromiseLike<Uint8Array>;
}

interface LoadedTheme {
  id: string;
  /** Root theme directory, used to resolve relative asset paths of inlined definitions. */
  baseDir: string;
  /** Raw definitions: assets are read and inlined only when a path actually resolves to them. */
  definitions: Record<string, IconDefinition>;
  fonts: FontDefinition[];
  variants: Partial<Record<ThemeVariant, Associations>>;
  associations: Associations;
  /** Inlined definitions, keyed by variant + definition id (variant styles can change the asset). */
  inlined: Map<string, IconDefinition>;
  inlinedFonts: Map<string, FontDefinition>;
}

interface ResolvedDefinition {
  id: string;
  definition: IconDefinition;
  font?: FontDefinition;
}

export interface FileIconsResponse {
  /** Every requested path appears; `null` means the theme has no icon for it. */
  icons: Record<string, FileIconData | null>;
  fonts: Record<string, FileIconFont>;
  /** The theme or color variant changed; the webview must drop its cached icons. */
  reset: boolean;
}

/** Strips URI query/fragment and normalizes separators before matching. */
export function filePathParts(path: string | undefined): { full: string; base: string; parent: string } {
  const full = (path ?? "").split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const segments = full.split("/");
  return { full, base: segments.pop() ?? "", parent: segments.pop() ?? "" };
}

function lowerMap(map: Record<string, string> | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(map ?? {})) result.set(key.toLowerCase(), value);
  return result;
}

function mergeAssociations(base: Associations, override: Associations | undefined): Associations {
  if (!override) return base;
  return {
    file: override.file ?? base.file,
    fileExtensions: { ...base.fileExtensions, ...override.fileExtensions },
    fileNames: { ...base.fileNames, ...override.fileNames },
    languageIds: { ...base.languageIds, ...override.languageIds },
    iconDefinitions: { ...base.iconDefinitions, ...override.iconDefinitions },
    fonts: override.fonts ?? base.fonts,
  };
}

function parseTheme(json: string): ThemeFile {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object") throw new Error("file icon theme is not an object");
  return parsed as ThemeFile;
}

/** Matches a `files.associations` glob against a path (supports single and double stars and `?`). */
export function globMatches(glob: string, path: string): boolean {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[^\w\s/]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(path);
}

/** Derives the language id the way VS Code does for icon matching: no first-line matching. */
export function languageIdForPath(
  path: string,
  associations: Record<string, string>,
  languages: readonly LanguageContribution[],
): string | undefined {
  const { full, base } = filePathParts(path);
  const lower = base.toLowerCase();
  // `files.associations` is a user override; the most specific glob wins (VS Code does the same).
  const globs = Object.keys(associations).sort((a, b) => b.length - a.length);
  for (const glob of globs) {
    if (globMatches(glob, lower) || globMatches(glob, full)) return associations[glob];
  }
  let best: { id: string; score: number } | undefined;
  for (const language of languages) {
    if (language.filenames?.some((name) => name.toLowerCase() === lower)) {
      if (!best || best.score < 1000) best = { id: language.id, score: 1000 };
      continue;
    }
    for (const pattern of language.extensions ?? []) {
      const ext = pattern.replace(/^\*/, "").replace(/^\./, "").toLowerCase();
      if (ext && lower.endsWith(`.${ext}`) && (!best || best.score < ext.length + 1)) {
        best = { id: language.id, score: ext.length + 1 };
      }
    }
  }
  return best?.id;
}

/**
 * Association order documented for file icon themes:
 * file name with parent > file name > extension with parent > extension > language > default.
 */
export function resolveDefinitionId(
  theme: LoadedTheme,
  path: string,
  languageId: string | undefined,
  variant: ThemeVariant,
): string | undefined {
  const override = theme.variants[variant];
  const variantAssociations = mergeAssociations(theme.associations, override);
  const names = lowerMap(variantAssociations.fileNames);
  const extensions = lowerMap(variantAssociations.fileExtensions);
  const languages = lowerMap(variantAssociations.languageIds);
  const { base, parent } = filePathParts(path);
  const lowerBase = base.toLowerCase();
  const lowerParent = parent.toLowerCase();

  if (lowerParent) {
    const withParent = names.get(`${lowerParent}/${lowerBase}`);
    if (withParent) return withParent;
  }
  const byName = names.get(lowerBase);
  if (byName) return byName;

  const parts = lowerBase.split(".");
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join(".");
    if (lowerParent) {
      const withParent = extensions.get(`${lowerParent}/${suffix}`);
      if (withParent) return withParent;
    }
    const byExtension = extensions.get(suffix);
    if (byExtension) return byExtension;
  }

  if (languageId) {
    const byLanguage = languages.get(languageId.toLowerCase());
    if (byLanguage) return byLanguage;
  }
  return variantAssociations.file;
}

function fontFor(definition: IconDefinition, fonts: FontDefinition[]): FontDefinition | undefined {
  if (!definition.fontCharacter) return undefined;
  return fonts.find((font) => font.id === definition.fontId) ?? fonts[0];
}

function iconPathFor(iconPath: string | IconPathValue | undefined, variant: ThemeVariant): string | undefined {
  if (!iconPath) return undefined;
  if (typeof iconPath === "string") return iconPath;
  return iconPath[variant] ?? iconPath.iconPath;
}

function fontFamily(font: FontDefinition): string {
  return `oc-file-icon-${(font.id ?? "default").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function glyphOf(fontCharacter: string): string | undefined {
  const hex = fontCharacter.replace(/\\/g, "").trim();
  if (!/^[0-9a-f]+$/i.test(hex)) return undefined;
  try {
    return String.fromCodePoint(parseInt(hex, 16));
  } catch {
    return undefined;
  }
}

export class FileIconThemeService {
  private loaded?: LoadedTheme;
  private loadedId?: string;
  private lastKey?: string;
  private pendingReset = false;
  private readonly cache = new Map<string, FileIconData | null>();
  private readonly fonts = new Map<string, FileIconFont>();

  constructor(private readonly env: FileIconThemeEnv) {}

  /** Call when the selected theme, color variant, or language associations change. */
  invalidate(): void {
    this.loaded = undefined;
    this.loadedId = undefined;
    this.pendingReset = true;
    this.cache.clear();
    this.fonts.clear();
  }

  async resolve(paths: string[]): Promise<FileIconsResponse> {
    const id = this.env.themeId();
    const variant = this.env.variant();
    const key = `${id ?? ""}|${variant}`;
    const reset = this.pendingReset || (this.lastKey !== undefined && this.lastKey !== key);
    this.pendingReset = false;
    this.lastKey = key;

    let theme: LoadedTheme | undefined;
    if (id) {
      if (!this.loaded || this.loadedId !== id) {
        const loaded = await this.load(id);
        this.invalidate();
        this.loaded = loaded;
        this.loadedId = id;
      }
      theme = this.loaded;
    } else if (this.loaded) {
      this.invalidate();
    }

    const resolved = await Promise.all(paths.map(async (path) => {
      const cacheKey = `${variant}\0${path}`;
      if (this.cache.has(cacheKey)) return [path, this.cache.get(cacheKey) ?? null] as const;
      const icon = theme ? await this.resolveOne(theme, path, variant) : undefined;
      const value = icon ?? null;
      this.cache.set(cacheKey, value);
      return [path, value] as const;
    }));
    const icons = Object.fromEntries(resolved);
    return { icons, fonts: Object.fromEntries(this.fonts), reset };
  }

  private async resolveOne(theme: LoadedTheme, path: string, variant: ThemeVariant): Promise<FileIconData | undefined> {
    const languageId = languageIdForPath(path, this.env.associations(), this.env.languages());
    const definitionId = resolveDefinitionId(theme, path, languageId, variant);
    if (!definitionId) return undefined;
    const resolved = await this.definitionFor(theme, definitionId, variant);
    if (!resolved) return undefined;

    const { definition } = resolved;
    const svgPath = iconPathFor(definition.iconPath, variant);
    if (svgPath) {
      const src = svgPath.startsWith("data:")
        ? svgPath
        : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgPath)}`;
      return { kind: "svg", src };
    }

    const font = resolved.font;
    const glyph = definition.fontCharacter ? glyphOf(definition.fontCharacter) : undefined;
    if (!font || !glyph) return undefined;
    const family = fontFamily(font);
    this.registerFont(family, font);
    // In high contrast VS Code renders glyphs with the foreground color unless the theme has an
    // explicit highContrast section, so do not bake a font color into the chip in that case.
    const useColor = variant !== "highContrast" || !!theme.variants.highContrast;
    return {
      kind: "font",
      fontFamily: family,
      glyph,
      color: useColor ? definition.fontColor : undefined,
      size: definition.fontSize ?? font.size,
    };
  }

  private async definitionFor(theme: LoadedTheme, id: string, variant: ThemeVariant): Promise<ResolvedDefinition | undefined> {
    const override = theme.variants[variant]?.iconDefinitions?.[id];
    const definition = override ?? theme.definitions[id];
    if (!definition) return undefined;
    // VS Code inherits font properties from the default file icon definition.
    const defaultId = theme.variants[variant]?.file ?? theme.associations.file;
    const base = defaultId ? theme.definitions[defaultId] : undefined;
    const merged: IconDefinition = {
      ...definition,
      fontColor: definition.fontColor ?? base?.fontColor,
      fontSize: definition.fontSize ?? base?.fontSize,
      fontId: definition.fontId ?? base?.fontId,
    };
    const key = `${variant}\0${id}`;
    let inlined = theme.inlined.get(key);
    if (!inlined) {
      inlined = await this.inlineDefinition(merged, theme.baseDir);
      theme.inlined.set(key, inlined);
    }
    return { id, definition: inlined, font: await this.inlinedFontFor(theme, inlined) };
  }

  /** Reads/inlines a font only when a resolved glyph actually needs it. */
  private async inlinedFontFor(theme: LoadedTheme, definition: IconDefinition): Promise<FontDefinition | undefined> {
    if (!definition.fontCharacter) return undefined;
    const raw = fontFor(definition, theme.fonts);
    if (!raw) return undefined;
    const key = raw.id ?? "";
    let inlined = theme.inlinedFonts.get(key);
    if (!inlined) {
      inlined = {
        ...raw,
        src: await Promise.all((raw.src ?? []).map(async (source) => ({ ...source, path: await this.dataUri(source.path, theme.baseDir) }))),
      };
      theme.inlinedFonts.set(key, inlined);
    }
    return inlined;
  }

  private registerFont(family: string, font: FontDefinition): void {
    if (this.fonts.has(family)) return;
    const source = font.src[0];
    if (!source) return;
    // Only inline fonts can cross the webview boundary without extra resource roots.
    if (!/^data:/.test(source.path)) return;
    this.fonts.set(family, {
      family,
      src: source.path,
      format: source.format ?? "woff",
      weight: font.weight,
      style: font.style,
    });
  }

  private async load(id: string): Promise<LoadedTheme> {
    const location = this.env.locate(id);
    if (!location) throw new Error(`file icon theme not found: ${id}`);
    const seen = new Set<string>();
    let file = location;
    let combined: ThemeFile = {};
    while (file && !seen.has(file.jsonPath)) {
      seen.add(file.jsonPath);
      const theme = parseTheme(Buffer.from(await this.env.readFile(file.jsonPath)).toString("utf8"));
      combined = mergeThemeFiles(theme, combined);
      if (!theme.extends) break;
      const basePath = resolveRelative(file.baseDir, theme.extends);
      file = { jsonPath: basePath, baseDir: basePath.slice(0, basePath.lastIndexOf("/")) };
    }

    // Keep assets as paths. A Seti-style theme ships hundreds of SVGs plus a font; reading and
    // base64-encoding all of them before the first chip can render made the first attachment janky.
    // Each definition and font is inlined on first use and cached on the loaded theme instead.
    return {
      id,
      baseDir: location.baseDir,
      definitions: combined.iconDefinitions ?? {},
      fonts: combined.fonts ?? [],
      variants: { light: combined.light, highContrast: combined.highContrast },
      associations: {
        file: combined.file,
        fileExtensions: combined.fileExtensions,
        fileNames: combined.fileNames,
        languageIds: combined.languageIds,
      },
      inlined: new Map(),
      inlinedFonts: new Map(),
    };
  }

  private async inlineDefinition(definition: IconDefinition, baseDir: string): Promise<IconDefinition> {
    const inline = async (value: string | IconPathValue | undefined): Promise<string | IconPathValue | undefined> => {
      if (!value) return value;
      if (typeof value === "string") return this.dataUri(value, baseDir);
      return {
        ...value,
        iconPath: await this.dataUri(value.iconPath, baseDir),
        light: value.light ? await this.dataUri(value.light, baseDir) : undefined,
        dark: value.dark ? await this.dataUri(value.dark, baseDir) : undefined,
        highContrast: value.highContrast ? await this.dataUri(value.highContrast, baseDir) : undefined,
      };
    };
    return { ...definition, iconPath: await inline(definition.iconPath) };
  }

  private async dataUri(asset: string, baseDir: string): Promise<string> {
    if (asset.startsWith("data:")) return asset;
    // Remote assets are deliberately not fetched: this extension makes no network calls beyond the
    // configured OpenCode server, and the webview CSP blocks https images/fonts anyway. Returning an
    // empty value (instead of a URL the webview cannot load) makes the miss explicit.
    if (/^https?:/i.test(asset)) return "";
    const absolute = resolveRelative(baseDir, asset);
    const mime = /\.png$/i.test(absolute)
      ? "image/png"
      : /\.jpe?g$/i.test(absolute)
        ? "image/jpeg"
        : /\.gif$/i.test(absolute)
          ? "image/gif"
          : /\.svg$/i.test(absolute)
            ? "image/svg+xml"
            : /\.woff2$/i.test(absolute)
              ? "font/woff2"
              : /\.woff$/i.test(absolute)
                ? "font/woff"
                : /\.ttf$/i.test(absolute)
                  ? "font/ttf"
                  : "application/octet-stream";
    try {
      return `data:${mime};base64,${Buffer.from(await this.env.readFile(absolute)).toString("base64")}`;
    } catch {
      // A single missing asset must not disable every icon in the theme.
      return "";
    }
  }
}

function mergeThemeFiles(theme: ThemeFile, base: ThemeFile): ThemeFile {
  const merged = mergeAssociations(base, theme);
  return {
    ...merged,
    extends: theme.extends ?? base.extends,
    light: mergeAssociations(base.light ?? {}, theme.light),
    highContrast: mergeAssociations(base.highContrast ?? {}, theme.highContrast),
  };
}

function resolveRelative(baseDir: string, asset: string): string {
  if (asset.startsWith("/") || /^[a-zA-Z]:/.test(asset)) return asset;
  // Resolve so `./` and `../` segments cannot escape the theme directory as raw string fragments.
  return path.resolve(baseDir, asset);
}
