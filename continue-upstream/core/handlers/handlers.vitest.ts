import { describe, expect, it, vi } from "vitest";

import { CORE_HANDLER_MODULES } from "./index.js";
import startTalkHandlers from "./startTalk.js";
import type { CoreHandlerContext } from "./types.js";

/**
 * A context that answers any property with a no-op callable. The modules only
 * store or call what they touch at registration time, so this is enough to let
 * every `register()` run without standing up a `Core`.
 */
function stubContext(registered: string[]): CoreHandlerContext {
  const anything: any = new Proxy(function () {} as any, {
    get: (_target, prop) => {
      if (prop === "then") {
        return undefined; // don't let it look like a thenable
      }
      return anything;
    },
    apply: () => anything,
    construct: () => anything,
  });

  return new Proxy(
    {
      on: (messageType: string) => {
        registered.push(messageType);
      },
    } as any,
    {
      get: (target, prop) =>
        prop === "on" ? (target as any).on : anything,
    },
  ) as CoreHandlerContext;
}

function registerAll(): { module: string; types: string[] }[] {
  return CORE_HANDLER_MODULES.map((handlerModule) => {
    const types: string[] = [];
    handlerModule.register(stubContext(types));
    return { module: handlerModule.name, types };
  });
}

describe("core handler modules", () => {
  it("every module registers at least one message type", () => {
    for (const { module, types } of registerAll()) {
      expect(types, `module "${module}" registered nothing`).not.toHaveLength(0);
    }
  });

  it("relays Start Talk cancellation with the exact delegated request id", async () => {
    const registered = new Map<string, (message: any) => unknown>();
    const send = vi.fn();
    startTalkHandlers.register({
      on: (messageType: string, handler: (message: any) => unknown) => {
        registered.set(messageType, handler);
      },
      messenger: { send },
    } as any);

    await registered.get("startTalk/cancelMain")?.({
      data: { requestId: "voice-turn-7", reason: "barge-in" },
    });

    expect(send).toHaveBeenCalledWith("startTalk/cancelRunInMain", {
      requestId: "voice-turn-7",
      reason: "barge-in",
    });
  });

  it("never delegates a voice task without explicit user approval", async () => {
    const registered = new Map<string, (message: any) => unknown>();
    const send = vi.fn();
    startTalkHandlers.register({
      on: (messageType: string, handler: (message: any) => unknown) => {
        registered.set(messageType, handler);
      },
      messenger: { send },
    } as any);

    const delegate = registered.get("startTalk/delegateToMain");
    await delegate?.({
      data: { requestId: "not-approved", task: "run a command" },
    });
    expect(send).toHaveBeenCalledWith(
      "startTalk/mainResultReady",
      expect.objectContaining({ requestId: "not-approved", error: true }),
    );
    expect(send).not.toHaveBeenCalledWith(
      "startTalk/runInMain",
      expect.anything(),
    );

    send.mockClear();
    await delegate?.({
      data: {
        requestId: "approved",
        task: "run a command",
        userApproved: true,
      },
    });
    expect(send).toHaveBeenCalledWith(
      "startTalk/runInMain",
      expect.objectContaining({ requestId: "approved", userApproved: true }),
    );
  });

  it("module names are unique", () => {
    const names = CORE_HANDLER_MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no two modules claim the same message type", () => {
    // `messenger.on` keeps the last handler registered for a type, so a
    // collision would silently disable the first one.
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const { module, types } of registerAll()) {
      for (const type of types) {
        const previous = owner.get(type);
        if (previous) {
          collisions.push(`${type}: ${previous} and ${module}`);
        } else {
          owner.set(type, module);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("still serves every message type core owned before the split", () => {
    // One representative per module. If a module is dropped from the registry
    // its whole feature area goes quiet at runtime with no error, so this is
    // the assertion that catches it.
    const perModule: Record<string, string> = {
      session: "history/list",
      memory: "memory/get",
      config: "config/addModel",
      context: "context/getContextItems",
      autocomplete: "autocomplete/complete",
      edit: "streamDiffLines",
      startTalk: "startTalk/connect",
      privacy: "privacy/getPermissions",
      scheduler: "scheduler/list",
      indexing: "index/forceReIndex",
      files: "files/changed",
      docs: "docs/getDetails",
      tools: "tools/call",
    };

    const registered = new Set(registerAll().flatMap(({ types }) => types));
    for (const [module, type] of Object.entries(perModule)) {
      expect(registered.has(type), `${module} no longer serves ${type}`).toBe(
        true,
      );
    }
    expect(Object.keys(perModule).sort()).toEqual(
      CORE_HANDLER_MODULES.map((m) => m.name).sort(),
    );
  });
});
