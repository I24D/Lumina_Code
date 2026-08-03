import { Type } from "typebox";
import type { BridgeClient } from "../shared/bridge-client.js";
import { jsonResult, type AnyAgentTool } from "../shared/tool-result.js";

type WindowsContextResponse = {
  ok?: boolean;
  clock?: unknown;
  location?: unknown;
  network?: Record<string, unknown>;
  power?: unknown;
  operatingSystem?: unknown;
  storage?: unknown;
  services?: unknown;
  permissions?: unknown;
};

export function createWindowsContextTool(bridge: BridgeClient): AnyAgentTool {
  return {
    name: "lumina_windows_context",
    label: "Lumina Windows Context",
    description:
      "Reads current Windows date, time zone, approximate or configured location, connected Wi-Fi, " +
      "power, OS version, storage, and privacy permission state from the local Windows Bridge. " +
      "Use this instead of guessing current system facts. A network location is approximate and must " +
      "never be described as an exact physical position.",
    parameters: Type.Object({}),
    async execute() {
      const context = await bridge.get<WindowsContextResponse>("/system_context", 6_000);
      if (!context?.ok) {
        return jsonResult({
          ok: false,
          error: "windows_context_unavailable",
          hint: "Verify that the Lumina Windows Bridge is running on the configured bridge URL.",
        });
      }

      const network = context.network ?? {};
      return jsonResult({
        ok: true,
        clock: context.clock,
        location: context.location,
        network: {
          online: network.online,
          wifi: network.wifi,
          profiles: network.profiles,
        },
        power: context.power,
        operatingSystem: context.operatingSystem,
        storage: context.storage,
        services: context.services,
        permissions: context.permissions,
      });
    },
  };
}
