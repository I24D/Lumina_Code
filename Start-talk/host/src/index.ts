// Host standalone de Start Talk.
//
// Arranca el MISMO `core` de Lumina (agente, tools, MCP, voz) en un proceso
// Node headless — el papel que antes cumplia el host de la extension de VS Code —
// y expone el puente WebSocket del orbe. El shell Tauri lo lanza al abrir y se
// conecta leyendo `~/.lumina/orb-bridge.json`.
//
// core sigue viviendo en Lumina-Code; aqui SOLO se importa como libreria.

process.env.IS_BINARY = "true"; // core corre headless, igual que en `binary/`.

import { pathToFileURL } from "node:url";

import { Core } from "core/core";
import type { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { InProcessMessenger } from "core/protocol/messenger";

import { DesktopIde } from "./DesktopIde";
import { HostMessenger } from "./hostMessenger";
import { OrbBridgeServer } from "./OrbBridgeServer";
import { WebviewProtocolHost } from "./WebviewProtocolHost";
import {
  clearBridgeDiscovery,
  writeBridgeDiscovery,
} from "./bridgeDiscovery";

async function main(): Promise<void> {
  // FileSystemIde trabaja con URIs file://; core reenvia los workspace dirs a
  // los metodos del IDE, que hacen fileURLToPath(). Si pasamos una ruta plana,
  // la carga de config revienta con ERR_INVALID_URL_SCHEME.
  const workspacePath = process.env.LUMINA_WORKSPACE ?? process.cwd();
  const workspaceUri = pathToFileURL(workspacePath).toString();

  const ide = new DesktopIde(workspaceUri);
  const messenger = new InProcessMessenger<ToCoreProtocol, FromCoreProtocol>();
  const webviewProtocol = new WebviewProtocolHost();

  // OJO al orden: el puente (con getIdeInfo/getIdeSettings) debe existir ANTES
  // de crear Core, porque el constructor de Core los pide por el messenger.
  new HostMessenger(messenger, webviewProtocol, ide);

  const core = new Core(messenger, ide);
  void core; // Core se auto-registra en el messenger; la referencia lo mantiene vivo.

  const orbBridge = new OrbBridgeServer(webviewProtocol);
  const { port, token } = await orbBridge.start();

  writeBridgeDiscovery({
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  console.log(
    `[start-talk-host] listo. Orbe -> ws://127.0.0.1:${port}/?token=${token}`,
  );

  const shutdown = () => {
    clearBridgeDiscovery();
    orbBridge.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[start-talk-host] fallo fatal en el arranque:", error);
  process.exit(1);
});
