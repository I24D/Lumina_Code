import * as dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function toFilePath(candidate: string): string {
  return candidate.startsWith("file://") ? fileURLToPath(candidate) : candidate;
}

export function getWorkspaceEnvFiles(workspaceDirs: string[]): string[] {
  const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const roots = [
    ...workspaceDirs.map(toFilePath),
    moduleDir,
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "..", ".."),
  ];
  const envFiles = new Set<string>();

  for (const root of roots) {
    let current = path.resolve(root);
    while (true) {
      envFiles.add(path.join(current, ".env"));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return [...envFiles];
}

export function resolveWorkspaceEnvValue(
  workspaceDirs: string[],
  names: string[],
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  for (const filepath of getWorkspaceEnvFiles(workspaceDirs)) {
    if (!fs.existsSync(filepath)) continue;
    const parsed = dotenv.parse(fs.readFileSync(filepath));
    for (const name of names) {
      const value = parsed[name]?.trim();
      if (value) return value;
    }
  }

  return undefined;
}
