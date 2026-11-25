/** Modules esbuild leaves outside the single ESM bundle (native addons and platform packages). */
export const EXTERNAL_MODULES = [
  "@yuuang/*",
  "@parcel/watcher-*",
  "node-pty",
  "@lydell/node-pty",
  "@ff-labs/fff-bin-*",
  "@silvia-odwyer/photon-node",
  "@number0/iroh-*",
];

/** Expand an npm wildcard pattern to the package names installed under node_modules. */
export function expandPattern(pattern, installed) {
  if (!pattern.includes("*")) return [pattern];
  const [prefix] = pattern.split("*");
  return installed.filter((name) => name.startsWith(prefix));
}
