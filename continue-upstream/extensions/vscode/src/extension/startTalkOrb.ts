import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getStartTalkRetryDelayMs } from "core/startTalk/resiliencePolicy";
import * as vscode from "vscode";

import {
  type ProcessLock,
  releaseProcessLock,
  tryAcquireProcessLock,
} from "../util/processLock";

import { OrbBridgeServer } from "./OrbBridgeServer";

import type { VsCodeWebviewProtocol } from "../webviewProtocol";

/**
 * Lanza el orbe de Start Talk: la MISMA gui de Lumina Code corriendo en una
 * ventana Tauri sin bordes y siempre-encima, fuera de VS Code y movible entre
 * monitores. El cerebro (Gemini Live, mic, delegación al agente) sigue en core;
 * el orbe se conecta por WebSocket al `OrbBridgeServer`.
 */

const KEEP_ALIVE_KEY = "lumina.startTalk.keepAlive";
const ORB_PID_KEY = "lumina.startTalk.pid";
const ORB_LOCK_FILE = "start-talk-orb.lock";
const STABLE_PROCESS_MS = 60_000;

let bridge: OrbBridgeServer | undefined;
let orbProcess: ChildProcess | undefined;
let orbLock: ProcessLock | undefined;
let supervisorContext: vscode.ExtensionContext | undefined;
let supervisorProtocol: VsCodeWebviewProtocol | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let stableTimer: ReturnType<typeof setTimeout> | undefined;
let restartAttempts = 0;
let disposing = false;
let disposeRegistered = false;

/** Rutas candidatas del ejecutable del orbe (release primero, luego debug). */
export function resolveStartTalkOrbExecutable(
  context: vscode.ExtensionContext,
): string | undefined {
  const envExe = process.env.LUMINA_ORB_EXE;
  if (envExe && fs.existsSync(envExe)) {
    return envExe;
  }

  const startTalkRoot = path.resolve(
    context.extensionPath,
    "../../../Start-talk",
  );
  const candidates = [
    path.join(context.extensionPath, "native/start-talk/start-talk.exe"),
    path.join(startTalkRoot, "src-tauri/target/release/start-talk.exe"),
    path.join(startTalkRoot, "src-tauri/target/debug/start-talk.exe"),
    path.join(context.extensionPath, "native/start-talk/start-talk"),
    // no-Windows (por si acaso)
    path.join(startTalkRoot, "src-tauri/target/release/start-talk"),
    path.join(startTalkRoot, "src-tauri/target/debug/start-talk"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export async function launchStartTalkOrb(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
): Promise<void> {
  registerOrbSupervisor(context, webviewProtocol);
  disposing = false;
  await context.globalState.update(KEEP_ALIVE_KEY, true);

  if (orbProcess && orbProcess.exitCode === null) {
    void vscode.window.showInformationMessage(
      "El orbe de Start Talk ya está abierto.",
    );
    return;
  }

  await spawnStartTalkOrb(context, webviewProtocol, true);
}

/** Restaura el orbe después de una recarga del host de la extensión. */
export async function restoreStartTalkOrb(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
): Promise<void> {
  registerOrbSupervisor(context, webviewProtocol);
  disposing = false;
  if (!context.globalState.get<boolean>(KEEP_ALIVE_KEY, false)) {
    return;
  }

  await spawnStartTalkOrb(context, webviewProtocol, false);
}

function registerOrbSupervisor(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
): void {
  supervisorContext = context;
  supervisorProtocol = webviewProtocol;
  if (disposeRegistered) {
    return;
  }
  disposeRegistered = true;
  context.subscriptions.push({ dispose: disposeStartTalkOrb });
}

function acquireOrbLock(context: vscode.ExtensionContext): boolean {
  if (orbLock) {
    return false;
  }
  orbLock = tryAcquireProcessLock(
    path.join(context.globalStorageUri.fsPath, ORB_LOCK_FILE),
  );
  return Boolean(orbLock);
}

function releaseOrbLock(): void {
  const lock = orbLock;
  orbLock = undefined;
  try {
    releaseProcessLock(lock);
  } catch (error) {
    console.error(`[StartTalkOrb] Could not release orb lock: ${error}`);
  }
}

async function spawnStartTalkOrb(
  context: vscode.ExtensionContext,
  webviewProtocol: VsCodeWebviewProtocol,
  notifyOnFailure: boolean,
): Promise<void> {
  if (disposing || (orbProcess && orbProcess.exitCode === null)) {
    return;
  }

  const exe = resolveStartTalkOrbExecutable(context);
  if (!exe) {
    const message =
      "No se encontró el ejecutable del orbe. Compílalo con `npm run tauri build` en Lumina-Code/Start-talk.";
    if (notifyOnFailure) {
      void vscode.window.showErrorMessage(message);
    } else {
      console.error(`[StartTalkOrb] ${message}`);
      scheduleOrbRestart();
    }
    return;
  }

  let ownsOrbLock: boolean;
  try {
    ownsOrbLock = acquireOrbLock(context);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Orb lock could not be created.";
    if (notifyOnFailure) {
      void vscode.window.showErrorMessage(
        `No se pudo reservar Start Talk: ${message}`,
      );
    } else {
      console.error(`[StartTalkOrb] Lock acquisition failed: ${message}`);
    }
    scheduleOrbRestart();
    return;
  }
  if (!ownsOrbLock) {
    if (notifyOnFailure) {
      void vscode.window.showInformationMessage(
        "Start Talk ya se esta abriendo o esta controlado por otra ventana de VS Code.",
      );
    }
    return;
  }

  const stalePid = context.globalState.get<number>(ORB_PID_KEY);
  if (stalePid && stalePid !== orbProcess?.pid) {
    try {
      process.kill(stalePid, 0);
      process.kill(stalePid);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // The previous extension host may have already released the process.
    }
  }
  await context.globalState.update(ORB_PID_KEY, undefined);

  if (!bridge) {
    bridge = new OrbBridgeServer(webviewProtocol);
  }
  let port: number;
  let token: string;
  try {
    ({ port, token } = await bridge.start());
  } catch (error) {
    bridge.dispose();
    bridge = undefined;
    releaseOrbLock();
    const message =
      error instanceof Error ? error.message : "Orb bridge failed to start.";
    if (notifyOnFailure) {
      void vscode.window.showErrorMessage(
        `No se pudo iniciar el puente de Start Talk: ${message}`,
      );
    } else {
      console.error(`[StartTalkOrb] Bridge start failed: ${message}`);
    }
    scheduleOrbRestart();
    return;
  }
  const bridgeUrl = `ws://127.0.0.1:${port}/?token=${token}`;

  let child: ChildProcess;
  try {
    child = spawn(exe, [], {
      cwd: path.dirname(exe),
      env: { ...process.env, LUMINA_ORB_BRIDGE: bridgeUrl },
      windowsHide: false,
      detached: false,
    });
  } catch (error) {
    releaseOrbLock();
    const message =
      error instanceof Error ? error.message : "Orb process failed to start.";
    if (notifyOnFailure) {
      void vscode.window.showErrorMessage(
        `No se pudo lanzar el orbe de Start Talk: ${message}`,
      );
    } else {
      console.error(`[StartTalkOrb] Process start failed: ${message}`);
    }
    scheduleOrbRestart();
    return;
  }
  orbProcess = child;
  await context.globalState.update(ORB_PID_KEY, child.pid);

  child.on("spawn", () => {
    if (stableTimer) {
      clearTimeout(stableTimer);
    }
    stableTimer = setTimeout(() => {
      restartAttempts = 0;
      stableTimer = undefined;
    }, STABLE_PROCESS_MS);
  });

  child.on("error", (error) => {
    if (orbProcess !== child) {
      return;
    }
    orbProcess = undefined;
    void context.globalState.update(ORB_PID_KEY, undefined);
    releaseOrbLock();
    const message = `No se pudo lanzar el orbe de Start Talk: ${error.message}`;
    if (notifyOnFailure) {
      void vscode.window.showErrorMessage(message);
    } else {
      console.error(`[StartTalkOrb] ${message}`);
    }
    scheduleOrbRestart();
  });

  child.on("exit", (code) => {
    if (orbProcess !== child) {
      return;
    }
    orbProcess = undefined;
    void context.globalState.update(ORB_PID_KEY, undefined);
    releaseOrbLock();
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = undefined;
    }
    if (disposing) {
      return;
    }
    if (code === 0) {
      restartAttempts = 0;
      void context.globalState.update(KEEP_ALIVE_KEY, false);
      return;
    }
    scheduleOrbRestart();
  });
}

function scheduleOrbRestart(): void {
  if (
    disposing ||
    restartTimer ||
    !supervisorContext ||
    !supervisorProtocol ||
    !supervisorContext.globalState.get<boolean>(KEEP_ALIVE_KEY, false)
  ) {
    return;
  }

  restartAttempts += 1;
  const delayMs = getStartTalkRetryDelayMs(restartAttempts);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (!supervisorContext || !supervisorProtocol) {
      return;
    }
    void spawnStartTalkOrb(supervisorContext, supervisorProtocol, false);
  }, delayMs);
}

/** Cierra el orbe y libera el bridge al desactivar la extensión. */
export function disposeStartTalkOrb(): void {
  disposing = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = undefined;
  }
  if (orbProcess && orbProcess.exitCode === null) {
    orbProcess.kill();
  }
  orbProcess = undefined;
  bridge?.dispose();
  bridge = undefined;
  releaseOrbLock();
}
