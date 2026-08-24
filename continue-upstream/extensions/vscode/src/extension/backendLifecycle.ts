import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  type ProcessLock,
  releaseProcessLock,
  tryAcquireProcessLock,
} from "../util/processLock";

export type LuminaRuntimeComponentName =
  | "core"
  | "windowsBridge"
  | "modelRouter";

export type LuminaRuntimeComponentStatus = {
  name: LuminaRuntimeComponentName;
  label: string;
  status: "connected" | "starting" | "offline";
  endpoint: string;
  required: boolean;
};

export type LuminaRuntimeStatus = {
  state: "connected" | "degraded" | "offline" | "starting";
  managedByLuminaCode: boolean;
  components: LuminaRuntimeComponentStatus[];
  checkedAt: string;
};

type ProbeDefinition = {
  name: LuminaRuntimeComponentName;
  label: string;
  host: string;
  port: number;
  path?: string;
};

const PROBES: readonly ProbeDefinition[] = [
  {
    name: "core",
    label: "Lumina Core",
    host: "127.0.0.1",
    port: 3000,
    path: "/health",
  },
  {
    name: "windowsBridge",
    label: "Windows Bridge",
    host: "127.0.0.1",
    port: 8765,
    path: "/health",
  },
  {
    name: "modelRouter",
    label: "Model Router",
    host: "127.0.0.1",
    port: 4321,
    path: "/health",
  },
] as const;

const STARTUP_POLL_ATTEMPTS = 40;
const STARTUP_POLL_INTERVAL_MS = 1_500;
const RUNTIME_MONITOR_INTERVAL_MS = 10_000;
const WINDOWS_BRIDGE_LOCK_FILE = "windows-bridge-recovery.lock";

let runtimeProcess: ChildProcess | undefined;
let windowsBridgeRecoveryProcess: ChildProcess | undefined;
let windowsBridgeRecoveryLock: ProcessLock | undefined;
let ownsRuntime = false;
let startPromise: Promise<void> | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let runtimeMonitor: ReturnType<typeof setInterval> | undefined;

function log(message: string): void {
  const line = `[Lumina Runtime] ${message}`;
  console.log(line);
  outputChannel?.appendLine(line);
}

function isAutostartEnabled(): boolean {
  const configured = vscode.workspace
    .getConfiguration("lumina")
    .get<boolean>("runtime.autoStart", true);
  const environment = String(
    process.env.LUMINA_RUNTIME_AUTOSTART ??
      process.env.LUMINA_BACKEND_AUTOSTART ??
      "",
  ).toLowerCase();
  return configured && !["false", "0", "off"].includes(environment);
}

function probeTcp(
  host: string,
  port: number,
  timeoutMs = 1_200,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function probeHttp(
  definition: ProbeDefinition,
  timeoutMs = 1_500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: definition.host,
        port: definition.port,
        path: definition.path,
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status >= 200 && status < 500);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

async function probeComponent(definition: ProbeDefinition): Promise<boolean> {
  return definition.path
    ? probeHttp(definition)
    : probeTcp(definition.host, definition.port);
}

async function readComponentHealth(): Promise<
  Map<LuminaRuntimeComponentName, boolean>
> {
  const results = await Promise.all(
    PROBES.map(
      async (definition) =>
        [definition.name, await probeComponent(definition)] as const,
    ),
  );
  return new Map(results);
}

function resolveLuminaPcRoot(
  context: vscode.ExtensionContext,
): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("lumina")
    .get<string>("runtime.root", "");
  const candidates = [
    configured,
    process.env.LUMINA_PC_ROOT,
    // Development layout:
    //   <repo>/continue-upstream/extensions/vscode
    //   <repo>/Lumina_PC
    // Three parent traversals reach <repo>. Four traversals incorrectly
    // resolved to the drive root (for example C:\\Lumina_PC), which left the
    // optional local runtime permanently offline in a normal clone.
    path.resolve(context.extensionPath, "../../..", "Lumina_PC"),
    "C:\\I24D_WhatsApp\\Lumina_PC",
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (hasUnifiedRuntime(resolved) || resolveStandaloneBridgeRoot(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

function hasUnifiedRuntime(luminaPcRoot: string): boolean {
  return (
    fs.existsSync(path.join(luminaPcRoot, "package.json")) &&
    fs.existsSync(path.join(luminaPcRoot, "scripts", "dev-all.ts"))
  );
}

function resolveStandaloneBridgeRoot(
  luminaPcRoot: string,
): string | undefined {
  const bridgeRoot = path.join(
    luminaPcRoot,
    "apps",
    "lumina-windows-bridge",
  );
  return fs.existsSync(path.join(bridgeRoot, "src", "server.ts")) &&
    fs.existsSync(path.join(bridgeRoot, "package.json"))
    ? bridgeRoot
    : undefined;
}

function hasLiveRuntimeOrchestrator(luminaPcRoot: string): boolean {
  const runtimeDirectory = process.env.LUMINA_RUNTIME_DIR?.trim() || "runtime";
  const lockPath = path.resolve(luminaPcRoot, runtimeDirectory, "dev-all.lock");
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
    };
    if (
      typeof lock.pid !== "number" ||
      !Number.isInteger(lock.pid) ||
      lock.pid <= 0
    ) {
      return false;
    }
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function allComponentsConnected(
  health: Map<LuminaRuntimeComponentName, boolean>,
): boolean {
  return PROBES.every((definition) => health.get(definition.name) === true);
}

function buildRuntimeEnvironment(
  health: Map<LuminaRuntimeComponentName, boolean>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LUMINA_MODE: "development",
    LUMINA_CODE_EMBEDDED: "true",
    ENABLE_LUMINA_DESKTOP: "false",
    ENABLE_LUMINA_CORE: String(!health.get("core")),
    ENABLE_WINDOWS_BRIDGE: String(!health.get("windowsBridge")),
    ENABLE_MODEL_ROUTER: String(!health.get("modelRouter")),
    ENABLE_PERCEPTION: "true",
  };
}

function startWindowsBridgeRecovery(context: vscode.ExtensionContext): void {
  if (
    windowsBridgeRecoveryProcess &&
    windowsBridgeRecoveryProcess.exitCode === null
  ) {
    return;
  }

  const luminaPcRoot = resolveLuminaPcRoot(context);
  if (!luminaPcRoot) {
    log("Cannot recover Windows Bridge because Lumina_PC was not found.");
    return;
  }

  if (hasLiveRuntimeOrchestrator(luminaPcRoot)) {
    ownsRuntime = false;
    log("An existing dev:all orchestrator is supervising the runtime.");
    return;
  }

  const unifiedRuntime = hasUnifiedRuntime(luminaPcRoot);
  const bridgeRoot = resolveStandaloneBridgeRoot(luminaPcRoot);
  if (!unifiedRuntime && !bridgeRoot) {
    log("Windows Bridge sources were not found.");
    return;
  }

  try {
    windowsBridgeRecoveryLock = tryAcquireProcessLock(
      path.join(context.globalStorageUri.fsPath, WINDOWS_BRIDGE_LOCK_FILE),
    );
  } catch (error) {
    log(`Windows Bridge recovery lock failed: ${String(error)}`);
    return;
  }
  if (!windowsBridgeRecoveryLock) {
    return;
  }

  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          unifiedRuntime ? "npm run bridge:dev" : "npm run start",
        ]
      : ["run", unifiedRuntime ? "bridge:dev" : "start"];
  log("Windows Bridge is offline; starting its independent recovery process.");
  const child = spawn(command, args, {
    cwd: unifiedRuntime ? luminaPcRoot : bridgeRoot,
    env: {
      ...process.env,
      LUMINA_MODE: "development",
      LUMINA_CODE_EMBEDDED: "true",
    },
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  windowsBridgeRecoveryProcess = child;
  ownsRuntime = true;
  child.stdout?.on("data", (chunk: Buffer | string) =>
    outputChannel?.append(chunk.toString()),
  );
  child.stderr?.on("data", (chunk: Buffer | string) =>
    outputChannel?.append(chunk.toString()),
  );
  child.once("error", (error) => {
    releaseProcessLock(windowsBridgeRecoveryLock);
    windowsBridgeRecoveryLock = undefined;
    log(`Windows Bridge recovery failed to start: ${String(error)}`);
  });
  child.once("exit", (code) => {
    log(`Windows Bridge recovery exited with code ${code ?? "unknown"}.`);
    if (windowsBridgeRecoveryProcess === child) {
      windowsBridgeRecoveryProcess = undefined;
    }
    releaseProcessLock(windowsBridgeRecoveryLock);
    windowsBridgeRecoveryLock = undefined;
  });
}

async function startManagedRuntime(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!isAutostartEnabled()) {
    log("Automatic startup is disabled.");
    return;
  }

  let health = await readComponentHealth();
  if (allComponentsConnected(health)) {
    ownsRuntime = false;
    log("All runtime components are already connected.");
    return;
  }

  await sleep(1_500);
  health = await readComponentHealth();
  if (allComponentsConnected(health)) {
    ownsRuntime = false;
    log("All runtime components became ready during the startup grace period.");
    return;
  }

  const luminaPcRoot = resolveLuminaPcRoot(context);
  if (!luminaPcRoot) {
    log("Lumina_PC was not found; the coding workspace remains available.");
    return;
  }

  if (hasLiveRuntimeOrchestrator(luminaPcRoot)) {
    ownsRuntime = false;
    log("An existing dev:all orchestrator is supervising the runtime.");
    return;
  }

  if (!hasUnifiedRuntime(luminaPcRoot)) {
    startWindowsBridgeRecovery(context);
    for (
      let attempt = 0;
      attempt < STARTUP_POLL_ATTEMPTS;
      attempt += 1
    ) {
      if (await probeComponent(PROBES[1])) {
        log("Standalone Windows Bridge is ready.");
        return;
      }
      if (
        !windowsBridgeRecoveryProcess &&
        !windowsBridgeRecoveryLock
      ) {
        return;
      }
      await sleep(STARTUP_POLL_INTERVAL_MS);
    }
    log("Standalone Windows Bridge is still starting.");
    return;
  }

  const command =
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run dev:all"]
      : ["run", "dev:all"];
  log(`Starting the unified development runtime from ${luminaPcRoot}.`);
  const child = spawn(command, args, {
    cwd: luminaPcRoot,
    env: buildRuntimeEnvironment(health),
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtimeProcess = child;
  ownsRuntime = true;

  child.stdout?.on("data", (chunk: Buffer | string) =>
    outputChannel?.append(chunk.toString()),
  );
  child.stderr?.on("data", (chunk: Buffer | string) =>
    outputChannel?.append(chunk.toString()),
  );
  child.once("error", (error) =>
    log(`Runtime process failed to start: ${String(error)}`),
  );
  child.once("exit", (code) => {
    log(`Runtime orchestrator exited with code ${code ?? "unknown"}.`);
    if (runtimeProcess === child) {
      runtimeProcess = undefined;
      ownsRuntime = false;
    }
  });

  for (let attempt = 0; attempt < STARTUP_POLL_ATTEMPTS; attempt += 1) {
    if (!runtimeProcess) {
      return;
    }
    health = await readComponentHealth();
    if (allComponentsConnected(health)) {
      log("Unified runtime is ready.");
      return;
    }
    await sleep(STARTUP_POLL_INTERVAL_MS);
  }
  log(
    "Runtime startup is still in progress; see this output channel for component logs.",
  );
}

export function startLuminaRuntime(
  context: vscode.ExtensionContext,
): Promise<void> {
  outputChannel ??= vscode.window.createOutputChannel("Lumina Runtime");
  if (!runtimeMonitor) {
    runtimeMonitor = setInterval(() => {
      if (startPromise || !isAutostartEnabled()) {
        return;
      }
      void readComponentHealth().then((health) => {
        const luminaPcRoot = resolveLuminaPcRoot(context);
        const runtimeReady =
          luminaPcRoot && !hasUnifiedRuntime(luminaPcRoot)
            ? health.get("windowsBridge") === true
            : allComponentsConnected(health);
        if (
          luminaPcRoot &&
          hasLiveRuntimeOrchestrator(luminaPcRoot) &&
          !runtimeProcess
        ) {
          ownsRuntime = false;
          return;
        }
        if (!health.get("windowsBridge")) {
          startWindowsBridgeRecovery(context);
        }
        if (
          !runtimeReady &&
          !runtimeProcess &&
          !startPromise
        ) {
          log("Runtime components went offline; taking over supervision.");
          void beginRuntimeStartup(context);
        }
      });
    }, RUNTIME_MONITOR_INTERVAL_MS);
    runtimeMonitor.unref?.();
    context.subscriptions.push(outputChannel, {
      dispose: () => stopLuminaRuntime(),
    });
  }
  return beginRuntimeStartup(context);
}

function beginRuntimeStartup(context: vscode.ExtensionContext): Promise<void> {
  startPromise ??= startManagedRuntime(context)
    .catch((error) => {
      log(
        `Runtime startup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      startPromise = undefined;
    });
  return startPromise;
}

export async function getLuminaRuntimeStatus(
  context: vscode.ExtensionContext,
): Promise<LuminaRuntimeStatus> {
  const health = await readComponentHealth();
  const luminaPcRoot = resolveLuminaPcRoot(context);
  const standaloneBridgeProfile = Boolean(
    luminaPcRoot &&
      !hasUnifiedRuntime(luminaPcRoot) &&
      resolveStandaloneBridgeRoot(luminaPcRoot),
  );
  const requiredNames = new Set<LuminaRuntimeComponentName>(
    standaloneBridgeProfile
      ? ["windowsBridge"]
      : PROBES.map((definition) => definition.name),
  );
  const starting = standaloneBridgeProfile
    ? Boolean(
        windowsBridgeRecoveryProcess &&
          windowsBridgeRecoveryProcess.exitCode === null,
      )
    : Boolean(runtimeProcess && runtimeProcess.exitCode === null);
  const components = PROBES.map<LuminaRuntimeComponentStatus>((definition) => ({
    name: definition.name,
    label: definition.label,
    status: health.get(definition.name)
      ? "connected"
      : starting
        ? "starting"
        : "offline",
    endpoint: `${definition.host}:${definition.port}${definition.path ?? ""}`,
    required: requiredNames.has(definition.name),
  }));
  const requiredComponents = components.filter((component) => component.required);
  const connectedCount = requiredComponents.filter(
    (component) => component.status === "connected",
  ).length;

  const state: LuminaRuntimeStatus["state"] =
    connectedCount === requiredComponents.length
      ? "connected"
      : starting
        ? "starting"
        : connectedCount > 0
          ? "degraded"
          : "offline";

  return {
    state,
    managedByLuminaCode: ownsRuntime,
    components,
    checkedAt: new Date().toISOString(),
  };
}

export function stopLuminaRuntime(): void {
  if (runtimeMonitor) {
    clearInterval(runtimeMonitor);
    runtimeMonitor = undefined;
  }
  const child = runtimeProcess;
  const bridgeChild = windowsBridgeRecoveryProcess;
  runtimeProcess = undefined;
  windowsBridgeRecoveryProcess = undefined;
  releaseProcessLock(windowsBridgeRecoveryLock);
  windowsBridgeRecoveryLock = undefined;
  if (bridgeChild?.pid !== undefined) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(bridgeChild.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
    } else {
      bridgeChild.kill("SIGTERM");
    }
  }
  if (!child || !ownsRuntime || child.pid === undefined) {
    ownsRuntime = false;
    return;
  }

  ownsRuntime = false;
  log(`Stopping managed runtime process ${child.pid}.`);
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    return;
  }
  child.kill("SIGTERM");
}

export const startI24dBackend = startLuminaRuntime;
export const stopI24dBackend = stopLuminaRuntime;
