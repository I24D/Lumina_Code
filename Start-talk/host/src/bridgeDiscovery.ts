import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Descubrimiento del puente del orbe.
 *
 * El `OrbBridgeServer` escucha en 127.0.0.1 con un puerto EFIMERO y un token
 * aleatorio por sesion. Antes, VS Code arrancaba el orbe y le pasaba esa URL por
 * la env `LUMINA_ORB_BRIDGE`. Ahora que el host es propio, publicamos {port,
 * token} en un fichero conocido para que el shell Tauri (o cualquier lanzador)
 * lo lea y se conecte solo. Ver `src-tauri/src/lib.rs`.
 */
export interface OrbBridgeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

/** `~/.lumina/orb-bridge.json` — mismo hogar que el resto de hooks de Lumina. */
export function getBridgeDiscoveryPath(): string {
  return path.join(os.homedir(), ".lumina", "orb-bridge.json");
}

export function writeBridgeDiscovery(info: OrbBridgeInfo): void {
  const file = getBridgeDiscoveryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info, null, 2), "utf8");
}

/** URL lista para `new WebSocket(...)`, o undefined si no hay host vivo. */
export function readBridgeUrl(): string | undefined {
  try {
    const raw = fs.readFileSync(getBridgeDiscoveryPath(), "utf8");
    const info = JSON.parse(raw) as OrbBridgeInfo;
    if (!info?.port || !info?.token) {
      return undefined;
    }
    return `ws://127.0.0.1:${info.port}/?token=${info.token}`;
  } catch {
    return undefined;
  }
}

export function clearBridgeDiscovery(): void {
  try {
    fs.rmSync(getBridgeDiscoveryPath(), { force: true });
  } catch {
    // el fichero puede no existir; da igual
  }
}
