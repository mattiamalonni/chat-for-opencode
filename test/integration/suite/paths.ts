/**
 * VS Code normalizes the drive letter of Windows URIs to lowercase, while paths built from
 * `os.tmpdir()` / `path.join()` keep whatever casing the environment provided (here `C:`).
 * Both point at the same file, so compare paths with a normalized drive letter on Windows.
 */
export function normalizeFsPath(p: string): string {
  return process.platform === "win32" ? p.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase()) : p;
}
