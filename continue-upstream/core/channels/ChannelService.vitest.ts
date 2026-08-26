import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChannelService } from "./ChannelService.js";

const folders: string[] = [];

function makeService() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-channels-"));
  folders.push(folder);
  return new ChannelService(path.join(folder, "channels.json"));
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("ChannelService", () => {
  it("defaults to manual channels with immutable explicit approval", () => {
    const channels = makeService().get().channels;
    expect(channels).toHaveLength(2);
    expect(channels.every((channel) => channel.mode === "manual")).toBe(true);
    expect(
      channels.every((channel) => channel.requireExplicitApproval === true),
    ).toBe(true);
  });

  it("only admits suggestions from a configured trusted sender", () => {
    const service = makeService();
    service.update("whatsapp_desktop", {
      mode: "suggest",
      trustedSenders: ["José Pérez"],
    });

    expect(
      service.authorizeIngress("whatsapp_desktop", " jose perez "),
    ).toEqual({ allowed: true, reason: "allowed" });
    expect(service.authorizeIngress("whatsapp_desktop", "Unknown")).toEqual({
      allowed: false,
      reason: "untrusted_sender",
    });
  });

  it("persists disabled channels and blocks their tools", () => {
    const service = makeService();
    service.update("phone_link", { enabled: false });

    expect(() => service.assertEnabled("phone_link")).toThrow(/desactivado/u);
    expect(
      service.get().channels.find((item) => item.id === "phone_link"),
    ).toMatchObject({ enabled: false, mode: "manual" });
  });
});
