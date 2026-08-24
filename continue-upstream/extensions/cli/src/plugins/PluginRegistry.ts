import type { Tool } from "../tools/types.js";

import type {
  LuminaPlugin,
  PluginContribution,
  PluginContributionInput,
  PluginDiagnostic,
} from "./types.js";

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

export class PluginRegistry {
  private readonly plugins = new Map<string, LuminaPlugin>();
  private readonly contributions = new Map<string, PluginContribution>();
  private readonly toolNames = new Set<string>();
  private readonly diagnostics: PluginDiagnostic[] = [];
  private disposed = false;

  async registerPlugin(plugin: LuminaPlugin): Promise<void> {
    if (this.disposed) throw new Error("Plugin registry is disposed");
    if (!SAFE_PLUGIN_ID.test(plugin.id) || plugin.id.includes("..")) {
      throw new Error(`Invalid plugin ID: ${plugin.id}`);
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin is already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);

    const register = (contribution: PluginContributionInput): void => {
      this.registerContribution({
        ...contribution,
        pluginId: plugin.id,
        origin: plugin.origin,
      } as PluginContribution);
    };
    for (const contribution of plugin.contributions ?? []) {
      register(contribution);
    }
    try {
      await plugin.activate?.({ register });
    } catch (error) {
      this.diagnostics.push({
        pluginId: plugin.id,
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private registerContribution(contribution: PluginContribution): void {
    const key = `${contribution.pluginId}:${contribution.id}`;
    if (this.contributions.has(key)) {
      this.diagnostics.push({
        pluginId: contribution.pluginId,
        contributionId: contribution.id,
        severity: "error",
        message: `Duplicate contribution ID: ${contribution.id}`,
      });
      return;
    }
    if (contribution.kind === "tool") {
      if (this.toolNames.has(contribution.tool.name)) {
        this.diagnostics.push({
          pluginId: contribution.pluginId,
          contributionId: contribution.id,
          severity: "warning",
          message: `Tool name collision: ${contribution.tool.name}. The first registered tool remains active.`,
        });
        return;
      }
      this.toolNames.add(contribution.tool.name);
    }
    this.contributions.set(key, contribution);
  }

  getTools(): Tool[] {
    return this.getContributions("tool").map((item) => item.tool);
  }

  getContributions<K extends PluginContribution["kind"]>(
    kind?: K,
  ): Extract<PluginContribution, { kind: K }>[] {
    const items = [...this.contributions.values()];
    return (
      kind ? items.filter((item) => item.kind === kind) : items
    ) as Extract<PluginContribution, { kind: K }>[];
  }

  getDiagnostics(): PluginDiagnostic[] {
    return [...this.diagnostics];
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(
      [...this.plugins.values()]
        .reverse()
        .map((plugin) => plugin.deactivate?.()),
    );
    this.plugins.clear();
    this.contributions.clear();
    this.toolNames.clear();
  }
}
