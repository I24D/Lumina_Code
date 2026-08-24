import { describe, expect, it } from "vitest";

import { HookService } from "./HookService.js";

describe("HookService plugin overlay", () => {
  it("installs and replaces typed plugin hooks without duplicating file hooks", async () => {
    const service = new HookService();
    await service.initialize();
    service.setPluginContributions([
      {
        id: "hook:pre",
        pluginId: "custom:test",
        kind: "hook",
        origin: "custom",
        event: "PreToolUse",
        matcher: "Bash",
        handler: { type: "prompt", prompt: "Review $ARGUMENTS" },
      },
    ]);
    expect(service.getState().config.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "prompt", prompt: "Review $ARGUMENTS" }],
      },
    ]);

    service.setPluginContributions([]);
    expect(service.getState().config.PreToolUse).toBeUndefined();
  });
});
