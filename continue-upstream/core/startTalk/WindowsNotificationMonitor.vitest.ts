import { describe, expect, it } from "vitest";

import { parseNotificationMonitorLine } from "./WindowsNotificationMonitor.js";

describe("parseNotificationMonitorLine", () => {
  it("parses an allowed access event", () => {
    expect(
      parseNotificationMonitorLine(
        JSON.stringify({ kind: "status", status: "allowed" }),
      ),
    ).toEqual({ kind: "status", status: "allowed", message: undefined });
  });

  it("parses and trims a Windows notification", () => {
    const parsed = parseNotificationMonitorLine(
      JSON.stringify({
        kind: "notification",
        notification: {
          id: "notification-1",
          appName: " Outlook ",
          appUserModelId: " Microsoft.Outlook_123!App ",
          title: " New mail ",
          body: " Message body ",
          textElements: [" New mail ", " Message body "],
          createdAt: "2026-07-17T12:00:00.000Z",
        },
      }),
    );

    expect(parsed).toEqual({
      kind: "notification",
      notification: {
        id: "notification-1",
        appName: "Outlook",
        appUserModelId: "Microsoft.Outlook_123!App",
        title: "New mail",
        body: "Message body",
        createdAt: "2026-07-17T12:00:00.000Z",
        textElements: ["New mail", "Message body"],
        sourceKind: "windows",
      },
    });
  });

  it("rejects malformed or incomplete events", () => {
    expect(parseNotificationMonitorLine("not-json")).toBeUndefined();
    expect(
      parseNotificationMonitorLine(
        JSON.stringify({ kind: "notification", notification: { id: "1" } }),
      ),
    ).toBeUndefined();
  });
});
