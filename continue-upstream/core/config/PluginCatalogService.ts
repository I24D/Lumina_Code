import fs from "node:fs";
import path from "node:path";

import type { IDE } from "../index.js";
import { walkDir } from "../indexing/walkDir.js";
import { getContinueGlobalPath } from "../util/paths.js";
import { localPathToUri } from "../util/pathToUri.js";
import { joinPathsToUri } from "../util/uri.js";

export interface LuminaPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
}

export interface LuminaPluginCatalogEntry extends LuminaPluginManifest {
  path: string;
  enabled: boolean;
  skillFiles: string[];
  source: "workspace" | "global";
  error?: string;
}

type PluginState = Record<string, { enabled: boolean; updatedAt: string }>;

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

function pluginRoot(manifestPath: string): string {
  return manifestPath.slice(0, manifestPath.lastIndexOf("/"));
}

function validateManifest(value: unknown): LuminaPluginManifest {
  const manifest = value as Partial<LuminaPluginManifest> | undefined;
  if (!manifest || !PLUGIN_ID.test(manifest.id ?? "")) {
    throw new Error("plugin.json necesita un id slug válido.");
  }
  for (const field of ["name", "version", "description"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field]!.trim()) {
      throw new Error(`plugin.json necesita ${field}.`);
    }
  }
  return {
    id: manifest.id!,
    name: manifest.name!.trim().slice(0, 120),
    version: manifest.version!.trim().slice(0, 40),
    description: manifest.description!.trim().slice(0, 500),
  };
}

/**
 * A deliberately data-only plugin catalog. Plugins can contribute SKILL.md
 * procedures, but Lumina never imports or executes JavaScript from these
 * folders. MCP remains the explicit contract for executable extensions.
 */
export class PluginCatalogService {
  private readonly statePath: string;

  constructor(
    private readonly ide: IDE,
    options: { statePath?: string } = {},
  ) {
    this.statePath =
      options.statePath ??
      path.join(getContinueGlobalPath(), "lumina-plugin-state.json");
  }

  async list(): Promise<LuminaPluginCatalogEntry[]> {
    const workspaceRoots = (await this.ide.getWorkspaceDirs()).map(
      (workspace) => ({
        uri: joinPathsToUri(workspace, ".continue", "plugins"),
        source: "workspace" as const,
      }),
    );
    const roots = [
      ...workspaceRoots,
      {
        uri: localPathToUri(path.join(getContinueGlobalPath(), "plugins")),
        source: "global" as const,
      },
    ];
    const state = this.loadState();
    const entries = new Map<string, LuminaPluginCatalogEntry>();

    for (const root of roots) {
      if (!(await this.ide.fileExists(root.uri))) continue;
      const files = await walkDir(root.uri, this.ide, {
        source: "load Lumina plugin catalog",
      });
      for (const manifestPath of files.filter((file) =>
        file.endsWith("/plugin.json"),
      )) {
        try {
          const manifest = validateManifest(
            JSON.parse(await this.ide.readFile(manifestPath)),
          );
          if (entries.has(manifest.id)) continue;
          const rootPath = pluginRoot(manifestPath);
          const skillFiles = files.filter(
            (file) =>
              file.startsWith(`${rootPath}/`) && file.endsWith("/SKILL.md"),
          );
          entries.set(manifest.id, {
            ...manifest,
            path: rootPath,
            enabled: state[manifest.id]?.enabled !== false,
            skillFiles,
            source: root.source,
          });
        } catch (error) {
          const rootPath = pluginRoot(manifestPath);
          const id = `invalid-${entries.size + 1}`;
          entries.set(id, {
            id,
            name: "Plugin inválido",
            version: "?",
            description: "No se pudo cargar el manifiesto.",
            path: rootPath,
            enabled: false,
            skillFiles: [],
            source: root.source,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return [...entries.values()].sort(
      (left, right) =>
        Number(right.enabled) - Number(left.enabled) ||
        left.name.localeCompare(right.name),
    );
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<LuminaPluginCatalogEntry[]> {
    const entries = await this.list();
    const plugin = entries.find((entry) => entry.id === id && !entry.error);
    if (!plugin)
      throw new Error("El plugin no existe o su manifiesto es inválido.");
    const state = this.loadState();
    state[id] = { enabled, updatedAt: new Date().toISOString() };
    this.saveState(state);
    return entries.map((entry) =>
      entry.id === id ? { ...entry, enabled } : entry,
    );
  }

  private loadState(): PluginState {
    try {
      if (!fs.existsSync(this.statePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveState(state: PluginState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporary, this.statePath);
  }
}

export async function getEnabledPluginSkillFiles(ide: IDE): Promise<string[]> {
  return (await new PluginCatalogService(ide).list())
    .filter((plugin) => plugin.enabled && !plugin.error)
    .flatMap((plugin) => plugin.skillFiles);
}
