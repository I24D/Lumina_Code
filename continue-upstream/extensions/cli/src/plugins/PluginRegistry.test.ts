import { describe, expect, it, vi } from "vitest";

import type { Tool } from "../tools/types.js";

import { PluginRegistry } from "./PluginRegistry.js";
import type { LuminaPlugin } from "./types.js";

function tool(name: string): Tool {
  return {
    name,
    displayName: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    isBuiltIn: false,
    run: async () => name,
  };
}

function toolPlugin(id: string, name: string): LuminaPlugin {
  return {
    id,
    version: "1.0.0",
    origin: "custom",
    contributions: [
      { id: `tool:${name}`, kind: "tool", origin: "custom", tool: tool(name) },
    ],
  };
}

describe("PluginRegistry", () => {
  it("combines typed contributions without allowing tool overrides", async () => {
    const registry = new PluginRegistry();
    await registry.registerPlugin(toolPlugin("builtin:test", "Read"));
    await registry.registerPlugin(toolPlugin("custom:test", "Read"));

    expect(registry.getTools().map((item) => item.name)).toEqual(["Read"]);
    expect(registry.getDiagnostics()).toEqual([
      expect.objectContaining({
        pluginId: "custom:test",
        severity: "warning",
        message: expect.stringContaining("Tool name collision"),
      }),
    ]);
  });

  it("supports dynamic activation and reverse lifecycle cleanup", async () => {
    const deactivate = vi.fn();
    const registry = new PluginRegistry();
    await registry.registerPlugin({
      id: "custom:dynamic",
      version: "1.0.0",
      origin: "custom",
      activate: ({ register }) => {
        register({
          id: "tool:Dynamic",
          kind: "tool",
          origin: "builtin",
          tool: tool("Dynamic"),
        });
      },
      deactivate,
    });

    expect(registry.getTools()[0].name).toBe("Dynamic");
    expect(registry.getContributions("tool")[0].origin).toBe("custom");
    await registry.dispose();
    expect(deactivate).toHaveBeenCalledOnce();
    await expect(
      registry.registerPlugin(toolPlugin("custom:late", "Late")),
    ).rejects.toThrow("disposed");
  });

  it("rejects duplicate and unsafe plugin identifiers", async () => {
    const registry = new PluginRegistry();
    await registry.registerPlugin(toolPlugin("custom:one", "One"));
    await expect(
      registry.registerPlugin(toolPlugin("custom:one", "Two")),
    ).rejects.toThrow("already registered");
    await expect(
      registry.registerPlugin(toolPlugin("../unsafe", "Unsafe")),
    ).rejects.toThrow("Invalid plugin ID");
  });
});
