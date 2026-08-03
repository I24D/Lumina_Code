import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const labRoot = dirname(scriptDir);
const openClawRoot = "C:\\I24D_WhatsApp\\openclaw-main";
const nodeName = "Windows Node (LUMINA)";
const screenshotPath = `${labRoot}\\artifacts\\gateway-screen-snapshot.png`;

function runOpenClaw(args) {
  const result = spawnSync(process.execPath, [".\\openclaw.mjs", ...args], {
    cwd: openClawRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }

  return JSON.parse(result.stdout);
}

function invoke(command, params) {
  return runOpenClaw([
    "nodes",
    "invoke",
    "--node",
    nodeName,
    "--command",
    command,
    "--params",
    JSON.stringify(params),
    "--json",
  ]);
}

const status = runOpenClaw(["nodes", "status", "--json"]);
const node = status.nodes?.find((entry) => entry.displayName === nodeName);
if (!node?.connected || node.approvalState !== "approved") {
  console.error(JSON.stringify({ ok: false, reason: "node-not-ready", node }, null, 2));
  process.exit(1);
}

const which = invoke("system.which", { bins: ["git", "node", "powershell"] });
const camera = invoke("camera.list", {});
const device = invoke("device.status", { sections: ["os", "cpu", "memory", "battery"] });
const screen = invoke("screen.snapshot", { format: "png", maxWidth: 800, includePointer: false });

mkdirSync(`${labRoot}\\artifacts`, { recursive: true });
writeFileSync(screenshotPath, Buffer.from(screen.payload.base64, "base64"));

console.log(JSON.stringify(
  {
    ok: true,
    node: {
      displayName: node.displayName,
      connected: node.connected,
      approvalState: node.approvalState,
      caps: node.caps,
      commands: node.commands,
    },
    which: which.payload,
    cameras: camera.payload.cameras?.map((entry) => ({
      name: entry.Name ?? entry.name,
      isDefault: entry.IsDefault ?? entry.isDefault,
    })),
    device: {
      os: device.payload.os,
      cpu: device.payload.cpu,
      memory: device.payload.memory,
      battery: device.payload.battery,
    },
    screenshot: {
      width: screen.payload.width,
      height: screen.payload.height,
      path: screenshotPath,
    },
  },
  null,
  2,
));
