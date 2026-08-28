import * as vscode from "vscode";

import { OrbBridgeServer, resolveOrbFrontendRoot } from "./OrbBridgeServer";

import type { VsCodeWebviewProtocol } from "../webviewProtocol";

/**
 * Abre el orbe de Start Talk: la MISMA gui de Lumina Code en una pestaña del
 * navegador, servida por `OrbBridgeServer` desde 127.0.0.1. El cerebro (voz,
 * micrófono, delegación al agente) sigue en core; la pestaña se conecta por
 * WebSocket al puente.
 *
 * Antes el orbe era un ejecutable Tauri que embebía la gui en tiempo de
 * compilación. Servirla elimina el `cargo build` de ~7 minutos por cada cambio
 * de interfaz y, con él, los fallos silenciosos por bundle desincronizado y por
 * ejecutable bloqueado. Lo que se pierde —ventana flotante siempre-encima— es
 * una decisión tomada a conciencia.
 *
 * No hay proceso hijo que supervisar: la pestaña la gobierna el usuario. El
 * puente sí sobrevive a una recarga del host de la extensión, reusando puerto y
 * token para que una pestaña abierta se reconecte sola.
 */

const KEEP_ALIVE_KEY = "lumina.startTalk.keepAlive";
const BRIDGE_PORT_KEY = "lumina.startTalk.bridgePort";
const BRIDGE_TOKEN_KEY = "lumina.startTalk.bridgeToken";

let bridge: OrbBridgeServer | undefined;
let disposeRegistered = false;

/** Arranca el puente y devuelve la URL del orbe, o `undefined` si no pudo. */
async function startBridge(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
  reuseSession: boolean,
): Promise<string | undefined> {
  if (!bridge) {
    const frontendRoot = resolveOrbFrontendRoot(
      context.extensionPath,
      context.extensionMode === vscode.ExtensionMode.Development,
    );
    if (!frontendRoot) {
      throw new Error(
        "No se encontró el bundle de la interfaz. Ejecuta `npm run build` en continue-upstream/gui.",
      );
    }
    bridge = new OrbBridgeServer(webviewProtocol, frontendRoot);
  }

  const { port, token } = await bridge.start({
    preferredPort: reuseSession
      ? context.globalState.get<number>(BRIDGE_PORT_KEY)
      : undefined,
    token: reuseSession
      ? context.globalState.get<string>(BRIDGE_TOKEN_KEY)
      : undefined,
  });
  await context.globalState.update(BRIDGE_PORT_KEY, port);
  await context.globalState.update(BRIDGE_TOKEN_KEY, token);
  return bridge.orbUrl();
}

export async function launchStartTalkOrb(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
): Promise<void> {
  registerOrbSupervisor(context);
  await context.globalState.update(KEEP_ALIVE_KEY, true);

  let url: string | undefined;
  try {
    url = await startBridge(context, webviewProtocol, false);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Orb bridge failed to start.";
    disposeStartTalkOrb();
    void vscode.window.showErrorMessage(
      `No se pudo iniciar Start Talk: ${message}`,
    );
    return;
  }

  if (url) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

/**
 * Reabre el puente tras una recarga del host de la extensión, en el mismo
 * puerto y con el mismo token, para que una pestaña ya abierta se reconecte sin
 * intervención. No abre una pestaña nueva: eso sería robar el foco al usuario.
 */
export async function restoreStartTalkOrb(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
): Promise<void> {
  registerOrbSupervisor(context);
  if (!context.globalState.get<boolean>(KEEP_ALIVE_KEY, false)) {
    return;
  }

  try {
    await startBridge(context, webviewProtocol, true);
  } catch (error) {
    console.error(`[StartTalkOrb] Bridge restore failed: ${error}`);
  }
}

function registerOrbSupervisor(context: vscode.ExtensionContext): void {
  if (disposeRegistered) {
    return;
  }
  disposeRegistered = true;
  context.subscriptions.push({ dispose: disposeStartTalkOrb });
}

/** Cierra el puente al desactivar la extensión. */
export function disposeStartTalkOrb(): void {
  bridge?.dispose();
  bridge = undefined;
}
