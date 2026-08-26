import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeNotificationMonitor } from "./BridgeNotificationMonitor.js";
import type { StartTalkNotification } from "./types.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function asWindows(): void {
  Object.defineProperty(process, "platform", { value: "win32" });
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function toast(id: string, createdAt: string) {
  return {
    id,
    appName: "Enlace Móvil",
    appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
    title: "Hugo Tennessee",
    body: "Ya voy saliendo",
    textElements: ["Hugo Tennessee", "Ya voy saliendo"],
    createdAt,
  };
}

/** Responde a cada sondeo con la lista que le toque por orden. */
function bridgeReturning(polls: unknown[][]): typeof fetch {
  let index = 0;
  return vi.fn(async () => {
    const notifications = polls[Math.min(index, polls.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, notifications }),
    } as Response;
  }) as unknown as typeof fetch;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for notifications");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  vi.unstubAllGlobals();
});

describe("BridgeNotificationMonitor", () => {
  it("recovers only the recent arrivals on the first poll", async () => {
    asWindows();
    vi.stubGlobal(
      "fetch",
      bridgeReturning([
        [
          toast("old", minutesAgo(60 * 24 * 2)),
          toast("recent", minutesAgo(1)),
          toast("older-but-recent", minutesAgo(3)),
        ],
      ]),
    );

    const announced: StartTalkNotification[] = [];
    const monitor = new BridgeNotificationMonitor({
      onNotification: (notification) => announced.push(notification),
      onStatus: () => undefined,
      pollIntervalMs: 10_000,
    });
    monitor.start();

    await waitFor(() => announced.length === 2);
    monitor.stop();

    // De lo más antiguo a lo más nuevo, y sin recitar el atraso de dos días.
    expect(announced.map((notification) => notification.id)).toEqual([
      "older-but-recent",
      "recent",
    ]);
  });

  it("announces what arrives after the baseline", async () => {
    asWindows();
    vi.stubGlobal(
      "fetch",
      bridgeReturning([
        [toast("pre-existing", minutesAgo(60))],
        [toast("pre-existing", minutesAgo(60)), toast("brand-new", minutesAgo(0))],
      ]),
    );

    const announced: StartTalkNotification[] = [];
    const monitor = new BridgeNotificationMonitor({
      onNotification: (notification) => announced.push(notification),
      onStatus: () => undefined,
      pollIntervalMs: 10,
    });
    monitor.start();

    await waitFor(() => announced.length === 1);
    monitor.stop();

    expect(announced[0]?.id).toBe("brand-new");
    expect(announced[0]?.sender).toBe("Hugo Tennessee");
    expect(announced[0]?.mobileApp).toBe("SMS");
  });
});
