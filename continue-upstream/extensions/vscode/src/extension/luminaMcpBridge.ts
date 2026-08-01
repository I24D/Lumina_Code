import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OrbBridgeServer } from "./OrbBridgeServer";

import type { VsCodeExtension } from "./VsCodeExtension";

/**
 * luminaMcpBridge.ts
 *
 * Publishes a local, always-on WebSocket surface so the standalone Lumina MCP
 * Gateway (Lumina_PC/apps/lumina-mcp-gateway) can drive the Lumina Code chat the
 * same way Start Talk and the desktop orb do — through the very same
 * `VsCodeWebviewProtocol`. This is what lets Claude (via the MCP Gateway) send a
 * message into the Lumina Code chat and get the agent's final answer back.
 *
 * We reuse `OrbBridgeServer` verbatim (127.0.0.1 only, per-session token) and
 * write its `{ port, token }` to `~/.lumina/mcp-bridge.json` so the out-of-
 * process gateway can discover and authenticate to it. The file is owned by the
 * current desktop user; the loopback bind + token keep other local processes
 * out. No traffic is exposed to the network here — internet exposure is the
 * gateway's job, behind its own secret and the Cloudflare tunnel.
 */

const BRIDGE_DIR = path.join(os.homedir(), ".lumina");
const BRIDGE_FILE = path.join(BRIDGE_DIR, "mcp-bridge.json");
const COORDINATE_REPAIR_INTERVAL_MS = 5_000;

let bridge: OrbBridgeServer | undefined;

function serializeCoordinates(port: number, token: string): string {
  return JSON.stringify(
    {
      transport: "ws",
      host: "127.0.0.1",
      port,
      token,
      url: `ws://127.0.0.1:${port}/?token=${token}`,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

function writeCoordinates(port: number, token: string): void {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  const payload = serializeCoordinates(port, token);
  // Write atomically so the gateway never reads a half-written file.
  const tmp = `${BRIDGE_FILE}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, BRIDGE_FILE);
}

function restoreCoordinatesIfMissing(port: number, token: string): void {
  try {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    fs.writeFileSync(BRIDGE_FILE, serializeCoordinates(port, token), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    console.error("[LuminaMcpBridge] no pudo republicar coordenadas:", error);
  }
}

type PublishedCoordinates = {
  pid?: unknown;
  port?: unknown;
  token?: unknown;
};

function readPublishedCoordinates(): PublishedCoordinates {
  return JSON.parse(
    fs.readFileSync(BRIDGE_FILE, "utf8"),
  ) as PublishedCoordinates;
}

function removeCoordinates(port: number, token: string): void {
  try {
    const published = readPublishedCoordinates();
    if (
      published.pid !== process.pid ||
      published.port !== port ||
      published.token !== token
    ) {
      return;
    }
    fs.rmSync(BRIDGE_FILE, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // best-effort cleanup
  }
}

/**
 * Starts the MCP bridge once the sidebar webview protocol is ready and keeps its
 * coordinates published for the lifetime of the extension host.
 */
export function startLuminaMcpBridge(
  context: { subscriptions: { push(disposable: { dispose(): void }): void } },
  extensionInstance: VsCodeExtension,
): void {
  void (async () => {
    try {
      const webviewProtocol = await extensionInstance.webviewProtocolPromise;
      if (!webviewProtocol) {
        console.error("[LuminaMcpBridge] webviewProtocol no disponible");
        return;
      }

      if (!bridge) {
        bridge = new OrbBridgeServer(webviewProtocol);
      }
      const { port, token } = await bridge.start();
      writeCoordinates(port, token);
      const coordinateRepairTimer = setInterval(
        () => restoreCoordinatesIfMissing(port, token),
        COORDINATE_REPAIR_INTERVAL_MS,
      );
      console.log(`[LuminaMcpBridge] escuchando en 127.0.0.1:${port}`);

      context.subscriptions.push({
        dispose: () => {
          clearInterval(coordinateRepairTimer);
          removeCoordinates(port, token);
          bridge?.dispose();
          bridge = undefined;
        },
      });
    } catch (error) {
      console.error("[LuminaMcpBridge] no se pudo iniciar:", error);
    }
  })();
}
