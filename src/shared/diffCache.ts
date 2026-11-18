/**
 * Oldest cached entry that is not currently open in an editor. Cached content backs virtual diff
 * documents, so evicting a document that a diff tab still displays would make that tab go blank.
 */
export function evictableKey(contents: Map<string, string>, openUris: Set<string>): string | undefined {
  for (const key of contents.keys()) if (!openUris.has(key)) return key;
  return undefined;
}
