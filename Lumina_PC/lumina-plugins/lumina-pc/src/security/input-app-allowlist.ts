import path from "node:path";

export function normalizeInputAppName(value: string): string {
  const basename = path.win32.basename(value.trim()).toLowerCase();
  return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
}

export function normalizeInputAppAllowlist(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeInputAppName).filter(Boolean))].sort();
}

export function isInputAppAllowed(
  processName: string,
  allowedApps: readonly string[],
): boolean {
  const normalized = normalizeInputAppName(processName);
  return normalizeInputAppAllowlist(allowedApps).includes(normalized);
}
