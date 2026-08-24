import type { LuminaPlugin } from "./types.js";

const externalPlugins = new Map<string, LuminaPlugin>();

/** Programmatic extension seam for embedders; registration never grants permission. */
export function registerCliPlugin(plugin: LuminaPlugin): () => Promise<void> {
  if (externalPlugins.has(plugin.id)) {
    throw new Error(`CLI plugin is already registered: ${plugin.id}`);
  }
  externalPlugins.set(plugin.id, plugin);
  return async () => {
    if (externalPlugins.delete(plugin.id)) {
      await plugin.deactivate?.();
    }
  };
}

export function getRegisteredCliPlugins(): LuminaPlugin[] {
  return [...externalPlugins.values()];
}
