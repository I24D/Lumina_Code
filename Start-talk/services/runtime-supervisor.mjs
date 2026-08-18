import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.START_TALK_ROOT
  ? resolve(process.env.START_TALK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(root, "runtime");
const logsDir = resolve(runtimeDir, "logs");
const statePath = resolve(runtimeDir, "start-talk-runtime.json");
const supervisorLog = resolve(logsDir, "supervisor.log");
const discoveryPath = resolve(os.homedir(), ".lumina", "orb-bridge.json");
const bridgePort = Number(process.env.LUMINA_BRIDGE_PORT || "8765");

mkdirSync(logsDir, { recursive: true });

function log(message) {
  appendFileSync(supervisorLog, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.pid !== process.pid && isProcessAlive(state.pid)) process.exit(0);
  } catch {
    // A stale or interrupted state file is replaced below.
  }
}

writeFileSync(
  statePath,
  JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() }, null, 2),
  "utf8",
);
log(`supervisor started pid=${process.pid}`);

function isPortOpen(port) {
  return new Promise((resolveCheck) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveCheck(open);
    };
    socket.setTimeout(600);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function isOrbHostOpen() {
  try {
    const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
    return typeof discovery.token === "string" && discovery.token.length > 0 && await isPortOpen(Number(discovery.port));
  } catch {
    return false;
  }
}

function spawnLogged(name, args, env, stdoutName, stderrName, workingDirectory = root) {
  const stdoutFd = openSync(resolve(logsDir, stdoutName), "a");
  const stderrFd = openSync(resolve(logsDir, stderrName), "a");
  const child = spawn(process.execPath, args, {
    cwd: workingDirectory,
    env: { ...process.env, ...env },
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  log(`${name} started pid=${child.pid}`);
  child.once("exit", (code, signal) => log(`${name} exited code=${code} signal=${signal || "none"}`));
  child.once("error", (error) => log(`${name} error=${error.message}`));
  return child;
}

let bridgeChild;
let hostChild;
let chatMonitorChild;
let checking = false;

async function ensureServices() {
  if (checking) return;
  checking = true;
  try {
    if (!(await isPortOpen(bridgePort))) {
      if (!bridgeChild || !isProcessAlive(bridgeChild.pid)) {
        bridgeChild = spawnLogged(
          "windows bridge",
          ["--experimental-strip-types", resolve(root, "windows-bridge", "src", "server.ts")],
          {
            LUMINA_REPO_ROOT: root,
            LUMINA_LOG_DIR: "runtime/logs",
            LUMINA_RUNTIME_DIR: "runtime",
            LUMINA_SIDECAR_DIR: resolve(root, "windows-bridge", "sidecars"),
            I24D_ENV_FILE: resolve(root, "..", ".env"),
            LUMINA_PERCEPTION_AUTOSTART: "false",
            LUMINA_VISION_STREAM_AUTOSTART: "false",
          },
          "bridge.out.log",
          "bridge.err.log",
        );
      }
    }

    if (!(await isOrbHostOpen())) {
      if (!hostChild || !isProcessAlive(hostChild.pid)) {
        hostChild = spawnLogged(
          "orb host",
          [resolve(root, "host", "dist", "index.cjs")],
          {
            LUMINA_WORKSPACE: resolve(root, "runtime", "workspace"),
            LUMINA_WINDOWS_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
          },
          "host.out.log",
          "host.err.log",
          resolve(root, "host"),
        );
      }
    }

    if (!chatMonitorChild || !isProcessAlive(chatMonitorChild.pid)) {
      chatMonitorChild = spawnLogged(
        "chat response monitor",
        [resolve(root, "services", "chat-response-monitor.mjs")],
        {
          START_TALK_ROOT: root,
          LUMINA_VOICE_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/voice/claude-response`,
        },
        "chat-monitor.out.log",
        "chat-monitor.err.log",
      );
    }
  } catch (error) {
    log(`health check error=${error instanceof Error ? error.message : String(error)}`);
  } finally {
    checking = false;
  }
}

function shutdown() {
  for (const child of [chatMonitorChild, hostChild, bridgeChild]) {
    if (child && isProcessAlive(child.pid)) child.kill();
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.pid === process.pid) rmSync(statePath, { force: true });
  } catch {
    // Nothing to clean.
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", () => {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.pid === process.pid) rmSync(statePath, { force: true });
  } catch {
    // Nothing to clean.
  }
});

await ensureServices();
setInterval(ensureServices, 3_000).unref();
setInterval(() => {}, 60_000);
