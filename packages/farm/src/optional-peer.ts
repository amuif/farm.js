/**
 * Feature packages that @farm.js/core declares as optional peer dependencies.
 * Apps that use the feature install the package; everything else skips it.
 * Core loads each one with a literal dynamic import on the feature's own code
 * path, and turns a missing package into an actionable install hint.
 */

/** Whether `error` reports that `packageName` itself (not one of its dependencies) is missing. */
export function isMissingPackageError(error: unknown, packageName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  if (typeof message !== "string") return false;
  // Node names the package itself, even for a subpath import.
  return message.includes(`'${packageName}'`) || message.includes(`"${packageName}"`);
}

/** `Install "sharp" to optimize images: pnpm add sharp` */
export function formatOptionalPeerInstallHint(
  packageName: string,
  purpose: string,
  options: { dev?: boolean } = {},
): string {
  return `Install "${packageName}" to ${purpose}: pnpm add ${options.dev ? "-D " : ""}${packageName}`;
}
