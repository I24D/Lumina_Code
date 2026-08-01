import { describe, expect, test, vi } from "vitest";
import { pathToFileURL } from "node:url";

import type { ToolExtras } from "../..";
import { luminaWindowsBridgeTool } from "../definitions/luminaWindowsBridge";
import {
  luminaWindowsBridgeImpl,
  normalizeLuminaBridgeToolBody,
} from "./luminaWindowsBridge";

function createExtras() {
  const calls: Array<{ url: string; init: any }> = [];
  const extras = {
    fetch: vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    }),
    ide: {
      getWorkspaceDirs: vi.fn(async () => []),
    },
    tool: luminaWindowsBridgeTool,
    config: {},
  } as unknown as ToolExtras;

  return { calls, extras };
}

describe("luminaWindowsBridgeImpl", () => {
  test("calls GET /health with omitted body", async () => {
    const { calls, extras } = createExtras();

    await luminaWindowsBridgeImpl(
      {
        endpoint: "/health",
        bridgeUrl: "http://127.0.0.1:8765",
      },
      extras,
    );

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8765/health",
      init: { method: "GET" },
    });
    expect(calls[0].init.body).toBeUndefined();
  });

  test("normalizes empty string body for GET endpoints", async () => {
    const { calls, extras } = createExtras();

    await luminaWindowsBridgeImpl(
      {
        endpoint: "/health",
        body: "",
        bridgeUrl: "http://127.0.0.1:8765",
      },
      extras,
    );

    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
  });

  test("normalizes null body to empty object", () => {
    expect(normalizeLuminaBridgeToolBody({ body: null }, "/health")).toEqual(
      {},
    );
  });

  test("keeps JSON object body for POST endpoints", async () => {
    const { calls, extras } = createExtras();

    await luminaWindowsBridgeImpl(
      {
        endpoint: "/window_control",
        body: { action: "list" },
        bridgeUrl: "http://127.0.0.1:8765",
      },
      extras,
    );

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8765/window_control",
      init: { method: "POST" },
    });
    expect(calls[0].init.body).toBe(JSON.stringify({ action: "list" }));
  });

  test("calls the expanded WhatsApp message endpoint", async () => {
    const { calls, extras } = createExtras();

    await luminaWindowsBridgeImpl(
      {
        endpoint: "/whatsapp/messages",
        body: { contact: "Sandra", limit: 10 },
        bridgeUrl: "http://127.0.0.1:8765",
      },
      extras,
    );

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:8765/whatsapp/messages",
      init: { method: "POST" },
    });
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      contact: "Sandra",
      limit: 10,
    });
  });

  test("adds VS Code workspace context to POST bodies", async () => {
    const { calls, extras } = createExtras();
    vi.mocked(extras.ide.getWorkspaceDirs).mockResolvedValue([
      pathToFileURL(process.cwd()).href,
    ]);

    await luminaWindowsBridgeImpl(
      {
        endpoint: "/execute_powershell_safe",
        body: { command: "Get-Location" },
        bridgeUrl: "http://127.0.0.1:8765",
      },
      extras,
    );

    const body = JSON.parse(calls[0].init.body);
    expect(body.command).toBe("Get-Location");
    expect(body.cwd).toBe(process.cwd());
    expect(body.workspaceDir).toBe(process.cwd());
    expect(body.workspacePaths).toEqual([process.cwd()]);
    expect(body.vscodeWorkspaceDirs).toEqual([
      pathToFileURL(process.cwd()).href,
    ]);
  });

  test("throws clear error for missing endpoint", async () => {
    const { extras } = createExtras();

    await expect(luminaWindowsBridgeImpl({ body: {} }, extras)).rejects.toThrow(
      "requires a non-empty string endpoint",
    );
  });

  test("throws clear error for non-empty string body", () => {
    expect(() =>
      normalizeLuminaBridgeToolBody({ body: "texto" }, "/health"),
    ).toThrow("body must be a JSON object");
  });

  test("disables Bridge PowerShell file mutation attempts", () => {
    expect(
      luminaWindowsBridgeTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        {
          endpoint: "/execute_powershell_safe",
          body: {
            command:
              "New-Item -ItemType File -Path src/app.ts; Set-Content src/app.ts 'code'",
          },
        },
      ),
    ).toBe("disabled");
  });

  test("keeps non-mutating Bridge calls available", () => {
    expect(
      luminaWindowsBridgeTool.evaluateToolCallPolicy!(
        "allowedWithoutPermission",
        {
          endpoint: "/window_control",
          body: { action: "list" },
        },
      ),
    ).toBe("allowedWithoutPermission");
  });

  // WhatsApp permission behaviour now lives on the dedicated lumina_whatsapp
  // tool (see luminaWhatsApp.ts); the bridge tool no longer owns /whatsapp/*.
});
