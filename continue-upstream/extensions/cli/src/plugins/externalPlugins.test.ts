import { afterEach, describe, expect, it } from "vitest";

import {
  getRegisteredCliPlugins,
  registerCliPlugin,
} from "./externalPlugins.js";

describe("external CLI plugins", () => {
  const unregister: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(unregister.splice(0).map((dispose) => dispose()));
  });

  it("registers a typed plugin and returns a cleanup handle", async () => {
    unregister.push(
      registerCliPlugin({
        id: "custom:example",
        version: "1.0.0",
        origin: "custom",
      }),
    );
    expect(getRegisteredCliPlugins().map((plugin) => plugin.id)).toContain(
      "custom:example",
    );
    await unregister.pop()!();
    expect(getRegisteredCliPlugins()).toEqual([]);
  });
});
