import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { collectWindowsSystemContext } from "./system-context.ts";
import { validatePhoneLinkReplyRequest } from "./phone-link-policy.ts";

const execFileAsync = promisify(execFile);
const startedAt = Date.now();
const bridgeDir = dirname(dirname(fileURLToPath(import.meta.url)));
function resolveDefaultRepoRoot(): string {
  const legacyRepoRoot = resolve(bridgeDir, "..", "..");
  const labSiblingRepoRoot = resolve(bridgeDir, "..", "..", "Lumina_PC");

  if (existsSync(resolve(labSiblingRepoRoot, "apps")) || existsSync(resolve(labSiblingRepoRoot, "runtime"))) {
    return labSiblingRepoRoot;
  }

  return legacyRepoRoot;
}

const repoRoot = process.env.LUMINA_REPO_ROOT
  ? resolve(process.env.LUMINA_REPO_ROOT)
  : resolveDefaultRepoRoot();

// Canonical env file lives one level above Lumina_PC/ at c:/I24D_WhatsApp/.env.
// Override with I24D_ENV_FILE if the operator needs to point somewhere else.
loadEnvFile(process.env.I24D_ENV_FILE ?? resolve(repoRoot, "..", ".env"));

const port = Number(process.env.LUMINA_BRIDGE_PORT ?? "8765");
const logDir = resolve(repoRoot, process.env.LUMINA_LOG_DIR ?? "logs");
const runtimeDir = resolve(repoRoot, process.env.LUMINA_RUNTIME_DIR ?? "runtime");
// Continuous perception cache (written by the perception sidecar in the
// interactive Windows session). Exposed at GET /perception so the WSL gateway
// can consume Lumina's current sight without a WSL→interactive-desktop gap.
const perceptionStatePath =
  process.env.LUMINA_PERCEPTION_LATEST_STATE ??
  resolve(runtimeDir, "perception", "latest-state.json");
const visionStreamStatePath =
  process.env.LUMINA_VISION_STREAM_LATEST_STATE ??
  resolve(runtimeDir, "vision-stream", "latest-state.json");
const visionStreamFramePath =
  process.env.LUMINA_VISION_STREAM_LATEST_FRAME ??
  resolve(runtimeDir, "vision-stream", "latest-frame.jpg");
const auditLog = resolve(logDir, "lumina-windows-bridge-audit.jsonl");
const alarmsDir = resolve(runtimeDir, "alarms");
const alarmPayloadDir = resolve(alarmsDir, "payloads");
const alarmRunnerPath = resolve(alarmsDir, "lumina-alarm-runner.ps1");
// UI Automation sidecars (comtypes/uiautomation — never PowerShell, per the
// Bitdefender AMSI rule). The bridge OWNS them under ./sidecars/ and shells out
// to them to expose native accessibility + input/window control. Override with
// LUMINA_SIDECAR_DIR if they need to live elsewhere.
const sidecarDir = process.env.LUMINA_SIDECAR_DIR
  ? resolve(process.env.LUMINA_SIDECAR_DIR)
  : resolve(bridgeDir, "sidecars");
const pythonExe = process.env.LUMINA_PYTHON ?? "python";
const uiaSidecar = resolve(sidecarDir, "uia_tree.py");
const captureSidecar = resolve(sidecarDir, "capture_analyze.py");
const perceptionSidecar = resolve(sidecarDir, "perception.py");
const visionStreamSidecar = resolve(sidecarDir, "vision_stream.py");
const nowPlayingSidecar = resolve(sidecarDir, "now_playing.py");
const playMediaSidecar = resolve(sidecarDir, "play_media.py");
// AMSI-safe native input/window control (ctypes SendInput / EnumWindows).
// Bitdefender AMSI blocks the equivalent PowerShell Add-Type P/Invoke, so these
// endpoints delegate here; the legacy PowerShell paths remain only as fallback.
const winInputSidecar = resolve(sidecarDir, "win_input.py");
const winWindowSidecar = resolve(sidecarDir, "win_window.py");
const visionClickSidecar = resolve(sidecarDir, "vision_click.py");
const notificationCenterSidecar = resolve(sidecarDir, "notification_center.py");
const notificationListenerSidecar = resolve(sidecarDir, "notification_listener.py");
const phoneLinkSidecar = resolve(sidecarDir, "phone_link.py");
const whatsappSidecar = resolve(sidecarDir, "whatsapp.py");
let perceptionProcess: ChildProcessWithoutNullStreams | undefined;
let perceptionStartedAt = 0;
let perceptionLastEventAt = 0;
let perceptionLastLine = "";
let visionStreamProcess: ChildProcessWithoutNullStreams | undefined;
let visionStreamStartedAt = 0;
let visionStreamLastEventAt = 0;
let visionStreamLastLine = "";
const bridgeEndpoints = [
  "GET /health",
  "GET /system_context",
  "GET /processes",
  "GET /camera_devices",
  "GET /logs",
  "GET /perception",
  "GET /vision_stream",
  "GET /phone_link/status",
  "GET /schema",
  "POST /perception_control",
  "POST /vision_stream_control",
  "POST /open_application",
  "POST /open_settings",
  "POST /execute_powershell_safe",
  "POST /clipboard",
  "POST /notify_toast",
  "POST /alarms",
  "POST /window_control",
  "POST /screenshot",
  "POST /input",
  "POST /input_control",
  "POST /ui_inspect",
  "POST /ui_interact",
  "POST /ui_wait",
  "POST /ui_capture",
  "POST /play_media",
  "POST /now_playing",
  "POST /vision_click",
  "POST /notifications",
  "POST /notifications/dismiss",
  "POST /notifications/live",
  "POST /phone_link/reply",
  "POST /whatsapp/contacts",
  "POST /whatsapp/messages",
  "POST /whatsapp/reply",
  "POST /whatsapp/statuses",
  "POST /whatsapp/status",
  "POST /voice/claude-response",
  "POST /voice/claude-response/pending",
];

// In-memory relay so Claude Code (a separate process) can hand its finished chat
// responses to Start Talk to be read aloud. Claude's `Stop` hook POSTs text to
// /voice/claude-response (enqueue); Lumina Core polls /voice/claude-response/pending
// (drain) while a Start Talk session is active. Items expire so a stale answer is
// never spoken minutes later when the voice reconnects.
interface ClaudeVoiceItem {
  id: string;
  text: string;
  createdAt: number;
}
const claudeVoiceQueue: ClaudeVoiceItem[] = [];
const CLAUDE_VOICE_MAX_QUEUE = 20;
const CLAUDE_VOICE_TTL_MS = 120_000;
let claudeVoiceSeq = 0;

mkdirSync(logDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(alarmPayloadDir, { recursive: true });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

const dangerousPowerShellPatterns = [
  /\bremove-item\b/i,
  /\brm\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bclear-content\b/i,
  /\bset-content\b/i,
  /\badd-content\b/i,
  /\bnew-item\b/i,
  /\bcopy-item\b/i,
  /\bmove-item\b/i,
  /\brename-item\b/i,
  /\bset-item\b/i,
  /\bset-itemproperty\b/i,
  /\bnew-itemproperty\b/i,
  /\bremove-itemproperty\b/i,
  /\bformat-volume\b/i,
  /\bclear-disk\b/i,
  /\binitialize-disk\b/i,
  /\bset-disk\b/i,
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bshutdown\b/i,
  /\bstop-process\b/i,
  /\bkill\b/i,
  /\bstop-service\b/i,
  /\brestart-service\b/i,
  /\bset-service\b/i,
  /\bregister-scheduledtask\b/i,
  /\bunregister-scheduledtask\b/i,
  /\bschtasks\b/i,
  /\btakeown\b/i,
  /\bicacls\b/i,
  /\bbcdedit\b/i,
  /\breg(?:\.exe)?\b/i,
  /\bnetsh\b/i,
  /\bnet(?:\.exe)?\b/i,
  /\bwinget\b/i,
  /\bchoco\b/i,
  /\bscoop\b/i,
  /\bset-executionpolicy\b/i,
  /\binvoke-expression\b/i,
  /\biex\b/i,
  /\bstart-process\b.*\b(runas|-verb\s+runas)\b/i,
  /\bstart-process\b.*\b(powershell|cmd|wscript|cscript|mshta)\b/i,
  />\s*[$\w.:\\/-]+/i,
];

const safePowerShellPrefixes = [
  "get-",
  "test-",
  "where-object",
  "foreach-object",
  "select-object",
  "measure-object",
  "sort-object",
  "format-list",
  "format-table",
  "out-string",
  "convertto-json",
  "convertfrom-json",
  // Network is open: Lumina must be able to reach her own Supabase / any HTTPS
  // endpoint from the safe shell path (read-only web calls, no local mutation).
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "irm",
  "curl",
  "wget",
];

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function appendAudit(event: string, payload: JsonRecord): void {
  const entry = {
    at: new Date().toISOString(),
    event,
    payload,
  };
  writeFileSync(auditLog, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

function sendJson(res: ServerResponse, status: number, body: JsonRecord): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: "not_found" });
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) return {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as JsonRecord;
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Lumina Windows Bridge must run in native Windows Node, not WSL/Linux");
  }
}

async function runPowerShell(command: string, timeoutMs = 15_000, cwd?: string): Promise<string> {
  assertWindows();
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  return stdout.trim();
}

async function runPowerShellDetailed(
  command: string,
  timeoutMs = 15_000,
  cwd?: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  assertWindows();
  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
      },
    );
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      timedOut: false,
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      killed?: boolean;
    };
    const exitCode =
      typeof err.code === "number"
        ? err.code
        : typeof err.code === "string" && Number.isFinite(Number(err.code))
          ? Number(err.code)
          : 1;
    return {
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
      exitCode,
      timedOut: err.killed === true || err.signal === "SIGTERM",
    };
  }
}

function isSafePowerShell(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  if (dangerousPowerShellPatterns.some((pattern) => pattern.test(command))) return false;
  return splitPowerShellCommandSegments(normalized).every((segment) => {
    const firstToken = segment.split(/\s+/u)[0] ?? "";
    return safePowerShellPrefixes.some((prefix) => firstToken.startsWith(prefix));
  });
}

function splitPowerShellCommandSegments(command: string): string[] {
  return command
    .split(/\||;|&&|\|\||\r?\n/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveWorkspaceCwd(body: JsonRecord): string {
  const direct = optionalAliasString(body, ["cwd", "workingDirectory", "workspaceDir", "repoRoot"]);
  if (direct) {
    const resolved = resolve(direct);
    if (isExistingDirectory(resolved)) {
      return resolved;
    }
  }

  const workspacePaths = body.workspacePaths;
  if (Array.isArray(workspacePaths)) {
    for (const path of workspacePaths) {
      if (typeof path !== "string" || !path.trim()) {
        continue;
      }
      const resolved = resolve(path);
      if (isExistingDirectory(resolved)) {
        return resolved;
      }
    }
  }

  return repoRoot;
}

function boundedInt(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function stringBody(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function stringAliasBody(body: JsonRecord, keys: string[], label: string): string {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  throw new Error(`${label} must be a non-empty string. Accepted fields: ${keys.join(", ")}`);
}

function optionalAliasString(body: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function isUrlLike(value: string): boolean {
  return /^(https?:\/\/|mailto:|ms-|spotify:|whatsapp:|microsoft-edge:)/iu.test(value);
}

async function handleOpenApplication(body: JsonRecord): Promise<JsonRecord> {
  const target = stringAliasBody(body, ["target", "appName", "application", "app", "name", "url"], "target");
  // AMSI-safe path: launch via the win_window.py ctypes sidecar (os.startfile /
  // ShellExecute + alias map). The legacy Get-StartApps PowerShell path below is
  // AMSI-blocked on this machine, so we prefer the sidecar.
  const native = await runPythonSidecar(winWindowSidecar, ["--action", "launch", "--json", JSON.stringify(body)], 15_000);
  if (native.error !== "sidecar_missing") {
    appendAudit("open_application", { target, ok: native.ok === true, via: "python" });
    return native;
  }
  const waitForWindow = body.waitForWindow === true;
  const timeoutMs = boundedInt(body.timeoutMs ?? body.timeout_ms, 10_000, 1_000, 60_000);
  const result = await launchApplicationTarget(target, {
    timeoutMs,
    waitForWindow,
  });
  appendAudit("open_application", { target, waitForWindow, result });
  return result;
}

async function handleOpenSettings(body: JsonRecord): Promise<JsonRecord> {
  const page = typeof body.page === "string" && body.page.trim() ? body.page.trim() : "";
  const target = page.startsWith("ms-settings:") ? page : `ms-settings:${page}`;
  appendAudit("open_settings", { target });
  await runPowerShell(`Start-Process ${JSON.stringify(target)}`);
  return { ok: true, target };
}

async function handlePowerShellSafe(body: JsonRecord): Promise<JsonRecord> {
  const command = stringBody(body, "command");
  const timeoutMs = boundedInt(body.timeout_ms ?? body.timeoutMs, 15_000, 1_000, 120_000);
  const cwd = resolveWorkspaceCwd(body);
  const safe = isSafePowerShell(command);
  appendAudit("execute_powershell_safe", {
    command,
    cwd,
    safe,
    timeoutMs,
    confirmed: body.confirm === true,
  });
  if (!safe) {
    return {
      ok: false,
      blocked: true,
      requiresConfirmation: true,
      error: "Command is outside the dev allowlist or matches a dangerous pattern",
    };
  }
  const result = await runPowerShellDetailed(command, timeoutMs, cwd);
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timeoutMs,
    timedOut: result.timedOut,
  };
}

async function handleProcesses(): Promise<JsonRecord> {
  const stdout = await runPowerShell(
    "Get-Process | Select-Object Id,ProcessName,MainWindowTitle,CPU,WorkingSet64 | ConvertTo-Json -Depth 3",
  );
  return { ok: true, processes: JSON.parse(stdout || "[]") as JsonValue };
}

let systemContextCache:
  | { expiresAt: number; value: JsonRecord }
  | undefined;
let systemContextRefresh: Promise<JsonRecord> | undefined;

function refreshSystemContext(): Promise<JsonRecord> {
  systemContextRefresh ??= collectWindowsSystemContext({
    runPowerShell,
    env: process.env,
  })
    .then((context) => {
      const value = context as JsonRecord;
      systemContextCache = {
        expiresAt: Date.now() + 60_000,
        value,
      };
      appendAudit("system_context", {
        locationSource:
          typeof value.location === "object" && value.location && !Array.isArray(value.location)
            ? ((value.location as JsonRecord).source ?? null)
            : null,
      });
      return value;
    })
    .finally(() => {
      systemContextRefresh = undefined;
    });
  return systemContextRefresh;
}

function withCurrentClock(context: JsonRecord): JsonRecord {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .replace("Z", offset);
  const previousClock =
    typeof context.clock === "object" && context.clock && !Array.isArray(context.clock)
      ? (context.clock as JsonRecord)
      : {};
  return {
    ...context,
    servedAt: now.toISOString(),
    clock: {
      ...previousClock,
      localIso,
      utcIso: now.toISOString(),
      localDisplay: new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }).format(now),
    },
  };
}

async function handleSystemContext(): Promise<JsonRecord> {
  if (systemContextCache && systemContextCache.expiresAt > Date.now()) {
    return withCurrentClock(systemContextCache.value);
  }
  if (systemContextCache) {
    void refreshSystemContext().catch(() => undefined);
    return { ...withCurrentClock(systemContextCache.value), stale: true };
  }
  return withCurrentClock(await refreshSystemContext());
}

async function handleCameraDevices(): Promise<JsonRecord> {
  const ps = `
$devices = @()
$pnp = @(Get-PnpDevice -Class Camera,Image -ErrorAction SilentlyContinue)
foreach ($device in $pnp) {
  $problemCode = $null
  $driverDesc = $null
  try {
    $props = Get-PnpDeviceProperty -InstanceId $device.InstanceId -ErrorAction SilentlyContinue
    $problemCode = ($props | Where-Object { $_.KeyName -eq "DEVPKEY_Device_ProblemCode" } | Select-Object -First 1).Data
    $driverDesc = ($props | Where-Object { $_.KeyName -eq "DEVPKEY_Device_DriverDesc" } | Select-Object -First 1).Data
  } catch {}
  $devices += [PSCustomObject]@{
    name = $device.FriendlyName
    status = "$($device.Status)"
    class = "$($device.Class)"
    instanceId = $device.InstanceId
    problemCode = $problemCode
    driverDescription = $driverDesc
  }
}
$devices | ConvertTo-Json -Compress -Depth 4
`;
  const stdout = await runPowerShell(ps, 15_000);
  const parsed = stdout ? (JSON.parse(stdout) as JsonValue) : [];
  return { ok: true, devices: Array.isArray(parsed) ? parsed : [parsed] };
}

function optionalString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function handleClipboard(body: JsonRecord): Promise<JsonRecord> {
  const action = stringBody(body, "action");
  if (action === "get") {
    const stdout = await runPowerShell("Get-Clipboard", 5_000);
    appendAudit("clipboard", { action });
    return { ok: true, text: stdout };
  }
  if (action === "set") {
    const text = typeof body.text === "string" ? body.text : "";
    await runPowerShell(`Set-Clipboard -Value ${JSON.stringify(text)}`, 5_000);
    appendAudit("clipboard", { action, length: text.length });
    return { ok: true, text };
  }
  throw new Error("action must be get or set");
}

async function handleNotifyToast(body: JsonRecord): Promise<JsonRecord> {
  const title = stringBody(body, "title").slice(0, 64);
  const message = stringBody(body, "message").slice(0, 256);
  const appId = optionalString(body, "app_id") ?? "OpenClaw Lumina DEV";
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
$template = @"
<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual></toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${JSON.stringify(appId)}).Show($toast)
`;
  await runPowerShell(ps, 8_000);
  appendAudit("notify_toast", { title, message });
  return { ok: true, title, message };
}

type AlarmRepeat = "once" | "daily" | "weekly";

function safeAlarmId(value?: string): string {
  const source = value?.trim() || `alarm-${Date.now()}`;
  return source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || `alarm-${Date.now()}`;
}

function alarmTaskName(id: string): string {
  return `LuminaAlarm_${safeAlarmId(id)}`;
}

function alarmPayloadPath(id: string): string {
  return resolve(alarmPayloadDir, `${safeAlarmId(id)}.json`);
}

function parseAlarmTime(body: JsonRecord): Date {
  const raw = typeof body.timeIso === "string" ? body.timeIso : body.timeLocal;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("timeIso or timeLocal must be provided");
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error("alarm time is not a valid date/time");
  }
  return date;
}

function normalizeRepeat(value: JsonValue | undefined): AlarmRepeat {
  if (value === "daily" || value === "weekly") return value;
  return "once";
}

function normalizeDaysOfWeek(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Map([
    ["sunday", "Sunday"],
    ["monday", "Monday"],
    ["tuesday", "Tuesday"],
    ["wednesday", "Wednesday"],
    ["thursday", "Thursday"],
    ["friday", "Friday"],
    ["saturday", "Saturday"],
  ]);
  const days: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const day = allowed.get(item.trim().toLowerCase());
    if (day && !days.includes(day)) days.push(day);
  }
  return days;
}

function boundedNumber(value: JsonValue | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function ensureAlarmRunner(): void {
  if (existsSync(alarmRunnerPath)) return;
  writeFileSync(
    alarmRunnerPath,
    String.raw`param(
  [Parameter(Mandatory=$true)][string]$PayloadPath
)

$ErrorActionPreference = "Continue"
$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
$title = if ($payload.title) { [string]$payload.title } else { "Lumina Alarm" }
$message = if ($payload.message) { [string]$payload.message } else { "Alarm time." }
$durationSec = if ($payload.durationSec) { [Math]::Min([Math]::Max([int]$payload.durationSec, 10), 1800) } else { 300 }
$appId = if ($payload.appId) { [string]$payload.appId } else { "Lumina OpenClaw DEV" }

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
  $toastXml = @"
<toast scenario="alarm" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$(Escape-Xml $title)</text>
      <text>$(Escape-Xml $message)</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true" />
</toast>
"@
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($toastXml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
  Write-Host "toast failed: $($_.Exception.Message)"
}

try {
  Add-Type -AssemblyName System.Speech
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $speaker.Rate = 0
  $speaker.Volume = 100
  $speaker.SpeakAsync("$title. $message") | Out-Null
} catch {
  Write-Host "speech failed: $($_.Exception.Message)"
}

$end = (Get-Date).AddSeconds($durationSec)
while ((Get-Date) -lt $end) {
  try {
    [System.Media.SystemSounds]::Exclamation.Play()
  } catch {}
  Start-Sleep -Seconds 2
}
`,
    "utf8",
  );
}

async function handleAlarms(body: JsonRecord): Promise<JsonRecord> {
  const action = stringBody(body, "action").toLowerCase();
  ensureAlarmRunner();

  if (action === "create") {
    const id = safeAlarmId(typeof body.id === "string" ? body.id : undefined);
    const title = (optionalString(body, "title") ?? "Lumina Alarm").slice(0, 80);
    const message = (optionalString(body, "message") ?? "Alarm time.").slice(0, 400);
    const repeat = normalizeRepeat(body.repeat);
    const daysOfWeek = normalizeDaysOfWeek(body.daysOfWeek);
    const time = parseAlarmTime(body);
    const durationSec = boundedNumber(body.durationSec, 300, 10, 1800);
    const payloadPath = alarmPayloadPath(id);
    const taskName = alarmTaskName(id);
    const payload = {
      id,
      title,
      message,
      repeat,
      daysOfWeek,
      timeIso: time.toISOString(),
      durationSec,
      appId: optionalString(body, "appId") ?? "Lumina OpenClaw DEV",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(payloadPath, JSON.stringify(payload, null, 2), "utf8");

    const daysPs = daysOfWeek.length > 0 ? daysOfWeek.join(",") : "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday";
    const triggerPs =
      repeat === "daily"
        ? "$trigger = New-ScheduledTaskTrigger -Daily -At $at"
        : repeat === "weekly"
          ? `$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${daysPs} -At $at`
          : "$trigger = New-ScheduledTaskTrigger -Once -At $at";
    const ps = `
$taskName = ${JSON.stringify(taskName)}
$taskPath = "\\Lumina\\"
$runner = ${JSON.stringify(alarmRunnerPath)}
$payload = ${JSON.stringify(payloadPath)}
$at = [DateTime]::Parse(${JSON.stringify(time.toISOString())})
${triggerPs}
$argument = "-NoProfile -ExecutionPolicy Bypass -File \`"$runner\`" -PayloadPath \`"$payload\`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description ${JSON.stringify(`Lumina alarm: ${title}`)} -Force | Out-Null
[PSCustomObject]@{ ok=$true; taskName=$taskName; taskPath=$taskPath; nextRunTime=(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName | Get-ScheduledTaskInfo).NextRunTime } | ConvertTo-Json -Compress
`;
    const stdout = await runPowerShell(ps, 20_000);
    appendAudit("alarm_create", { id, title, repeat, timeIso: time.toISOString(), taskName });
    return {
      ok: true,
      id,
      taskName,
      taskPath: "\\Lumina\\",
      timeIso: time.toISOString(),
      repeat,
      daysOfWeek,
      durationSec,
      scheduledTask: JSON.parse(stdout || "{}") as JsonValue,
      payloadPath,
    };
  }

  if (action === "list") {
    const ps = `
$tasks = @(Get-ScheduledTask -TaskPath "\\Lumina\\" -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "LuminaAlarm_*" })
$tasks | ForEach-Object {
  $info = $_ | Get-ScheduledTaskInfo
  [PSCustomObject]@{
    taskName = $_.TaskName
    state = "$($_.State)"
    nextRunTime = $info.NextRunTime
    lastRunTime = $info.LastRunTime
    lastTaskResult = $info.LastTaskResult
  }
} | ConvertTo-Json -Compress
`;
    const stdout = await runPowerShell(ps, 15_000);
    const parsed = stdout ? (JSON.parse(stdout) as JsonValue) : [];
    return { ok: true, alarms: Array.isArray(parsed) ? parsed : [parsed] };
  }

  if (action === "cancel") {
    const id = safeAlarmId(stringBody(body, "id"));
    const taskName = alarmTaskName(id);
    const ps = `
Unregister-ScheduledTask -TaskPath "\\Lumina\\" -TaskName ${JSON.stringify(taskName)} -Confirm:$false -ErrorAction SilentlyContinue
`;
    await runPowerShell(ps, 10_000);
    const payloadPath = alarmPayloadPath(id);
    if (existsSync(payloadPath)) rmSync(payloadPath, { force: true });
    appendAudit("alarm_cancel", { id, taskName });
    return { ok: true, id, taskName, cancelled: true };
  }

  if (action === "test") {
    const id = safeAlarmId(typeof body.id === "string" ? body.id : "test");
    const payloadPath = alarmPayloadPath(id);
    const payload = {
      id,
      title: optionalString(body, "title") ?? "Lumina Alarm Test",
      message: optionalString(body, "message") ?? "This is a native Windows alarm test.",
      durationSec: boundedNumber(body.durationSec, 12, 3, 60),
      appId: optionalString(body, "appId") ?? "Lumina OpenClaw DEV",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(payloadPath, JSON.stringify(payload, null, 2), "utf8");
    await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", alarmRunnerPath, "-PayloadPath", payloadPath], {
      timeout: 90_000,
      windowsHide: true,
      encoding: "utf8",
    });
    appendAudit("alarm_test", { id });
    return { ok: true, id, tested: true };
  }

  throw new Error("action must be create, list, cancel, or test");
}

type LaunchOptions = {
  timeoutMs: number;
  waitForWindow: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForWindow(
  query: string,
  timeoutMs: number,
): Promise<JsonRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  const needle = query.toLowerCase();

  while (Date.now() < deadline) {
    try {
      const stdout = await runPowerShell(LIST_WINDOWS_PS, 10_000);
      const parsed = JSON.parse(stdout || "[]") as JsonValue;
      const windows = Array.isArray(parsed) ? parsed : [parsed];
      const found = windows.find((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return false;
        }
        const title = typeof item.title === "string" ? item.title.toLowerCase() : "";
        const processName = typeof item.process === "string" ? item.process.toLowerCase() : "";
        return title.includes(needle) || processName.includes(needle);
      });
      if (found && typeof found === "object" && !Array.isArray(found)) {
        return found as JsonRecord;
      }
    } catch {
      // Keep waiting until timeout.
    }

    await sleep(350);
  }

  return undefined;
}

async function resolveStartApp(query: string): Promise<JsonRecord | undefined> {
  const safe = JSON.stringify(query);
  const ps = `
$needle = (${safe}).ToLower()
$apps = @(Get-StartApps -ErrorAction SilentlyContinue) | Where-Object { $_.Name }
$ranked = @(
  $apps | ForEach-Object {
    $name = "$($_.Name)"
    $appId = "$($_.AppID)"
    $lowerName = $name.ToLower()
    $lowerAppId = $appId.ToLower()
    $score = 999
    if ($lowerName -eq $needle) { $score = 0 }
    elseif ($lowerAppId -eq $needle) { $score = 1 }
    elseif ($lowerName.StartsWith($needle)) { $score = 2 }
    elseif ($lowerName.Contains($needle)) { $score = 3 }
    elseif ($lowerAppId.Contains($needle)) { $score = 4 }
    if ($score -lt 999) {
      [PSCustomObject]@{ name=$name; appId=$appId; score=$score }
    }
  } | Sort-Object -Property score,name
)
if ($ranked.Count -eq 0) {
  [PSCustomObject]@{ ok=$false; error="no_match"; query=$needle } | ConvertTo-Json -Compress
  exit 0
}
$pick = $ranked[0]
$alts = @($ranked | Select-Object -First 5 | ForEach-Object { @{ name=$_.name; appId=$_.appId; score=$_.score } })
[PSCustomObject]@{ ok=$true; picked=@{ name=$pick.name; appId=$pick.appId; score=$pick.score }; alternativeCount=$ranked.Count; alternatives=$alts } | ConvertTo-Json -Compress -Depth 4
`;
  const stdout = await runPowerShell(ps, 12_000);
  const parsed = JSON.parse(stdout || "{}") as JsonRecord;
  if (parsed.ok !== true || !parsed.picked || typeof parsed.picked !== "object" || Array.isArray(parsed.picked)) {
    return undefined;
  }

  return parsed;
}

async function launchAppId(
  appId: string,
  displayName?: string,
): Promise<JsonRecord> {
  const shellPath = `shell:AppsFolder\\${appId}`;
  const ps = `
$shellPath = ${JSON.stringify(shellPath)}
try {
  Start-Process -FilePath "explorer.exe" -ArgumentList $shellPath -ErrorAction Stop
  [PSCustomObject]@{ ok=$true; launched=$true; via="apps_folder"; shellPath=$shellPath } | ConvertTo-Json -Compress
} catch {
  try {
    $shell = New-Object -ComObject Shell.Application
    $shell.Open($shellPath)
    [PSCustomObject]@{ ok=$true; launched=$true; via="shell_application"; shellPath=$shellPath } | ConvertTo-Json -Compress
  } catch {
    [PSCustomObject]@{ ok=$false; launched=$false; error=$_.Exception.Message; shellPath=$shellPath } | ConvertTo-Json -Compress
  }
}
`;
  const stdout = await runPowerShell(ps, 12_000);
  const result = JSON.parse(stdout || "{}") as JsonRecord;
  return {
    ...result,
    app: {
      name: displayName ?? appId,
      appId,
    },
  };
}

async function launchRawTarget(target: string): Promise<JsonRecord> {
  const ps =
    target.toLowerCase().startsWith("shell:appsfolder\\")
      ? `Start-Process -FilePath "explorer.exe" -ArgumentList ${JSON.stringify(target)}`
      : `Start-Process -FilePath ${JSON.stringify(target)}`;
  await runPowerShell(ps, 12_000);
  return { ok: true, launched: true, target, via: isUrlLike(target) ? "url" : "start_process" };
}

async function launchApplicationTarget(
  target: string,
  options: LaunchOptions,
): Promise<JsonRecord> {
  const normalized = target.trim();
  const lower = normalized.toLowerCase();

  if (isUrlLike(normalized) || /^[a-z]:\\/iu.test(normalized) || lower.endsWith(".exe")) {
    const result = await launchRawTarget(normalized);
    if (options.waitForWindow) {
      result.window = (await waitForWindow(normalized, options.timeoutMs)) ?? null;
    }
    return result;
  }

  const resolvedStartApp = await resolveStartApp(normalized);
  if (resolvedStartApp?.picked && typeof resolvedStartApp.picked === "object" && !Array.isArray(resolvedStartApp.picked)) {
    const picked = resolvedStartApp.picked as JsonRecord;
    const appId = typeof picked.appId === "string" ? picked.appId : "";
    const name = typeof picked.name === "string" ? picked.name : normalized;
    if (appId) {
      const result = await launchAppId(appId, name);
      result.via = result.via ?? "start_apps";
      result.picked = picked;
      result.alternatives = resolvedStartApp.alternatives;
      if (options.waitForWindow) {
        result.window = (await waitForWindow(name, options.timeoutMs)) ?? null;
      }
      return result;
    }
  }

  const aliased = APPLICATIONS[lower];
  if (aliased) {
    const result = await launchRawTarget(aliased.target);
    result.displayName = aliased.displayName;
    result.application = lower;
    result.via = "alias";
    if (options.waitForWindow) {
      result.window = (await waitForWindow(aliased.displayName, options.timeoutMs)) ?? null;
    }
    return result;
  }

  const result = await launchRawTarget(normalized);
  if (options.waitForWindow) {
    result.window = (await waitForWindow(normalized, options.timeoutMs)) ?? null;
  }
  return result;
}

async function handleWindowControl(body: JsonRecord): Promise<JsonRecord> {
  const action = stringBody(body, "action");
  // AMSI-safe path: list/focus/close/launch/discover run via the win_window.py
  // sidecar (ctypes EnumWindows / SetForegroundWindow / PostMessage; discover
  // via Shell.Application AppsFolder). Falls through to the legacy PowerShell
  // path only if the sidecar file is missing.
  if (["list", "focus", "close", "launch", "discover"].includes(action)) {
    const { action: _action, ...rest } = body;
    const argv = ["--action", action, "--json", JSON.stringify(rest)];
    const r = await runPythonSidecar(winWindowSidecar, argv, 15_000);
    appendAudit("window_control", { action, ok: r.ok === true, via: "python" });
    if (r.error !== "sidecar_missing") return r;
  }
  if (action === "list") {
    const stdout = await runPowerShell(LIST_WINDOWS_PS, 15_000);
    const windows = JSON.parse(stdout || "[]") as JsonValue;
    return { ok: true, windows, count: Array.isArray(windows) ? windows.length : 1 };
  }
  if (action === "focus") {
    const title = stringBody(body, "title");
    const stdout = await runPowerShell(FOCUS_WINDOW_PS(title), 10_000);
    let focused = false;
    let foregroundProcess = "";
    try {
      const parsed = JSON.parse(stdout || "{}") as Record<string, unknown>;
      focused = parsed.found === true && parsed.focused === true;
      foregroundProcess = typeof parsed.foregroundProcess === "string" ? parsed.foregroundProcess : "";
    } catch {
      focused = stdout.trim().toLowerCase() === "true";
    }
    appendAudit("window_control", { action, title, focused, foregroundProcess });
    return {
      ok: focused,
      focused,
      title,
      foregroundProcess,
      error: focused ? undefined : `No window matching "${title}" found.`,
    };
  }
  if (action === "launch") {
    const application = stringAliasBody(body, ["application", "target", "appName", "app", "name"], "application");
    const waitForWindow = body.waitForWindow === true;
    const timeoutMs = boundedInt(body.timeoutMs ?? body.timeout_ms, 10_000, 1_000, 60_000);
    const result = await launchApplicationTarget(application, {
      timeoutMs,
      waitForWindow,
    });
    appendAudit("window_control", { action, application, waitForWindow, result });
    return result;
  }
  if (action === "close") {
    const pid = typeof body.pid === "number" ? body.pid : null;
    const title = optionalString(body, "title");
    const processName = optionalString(body, "processName");
    const force = body.force === true;
    if (pid === null && !title && !processName) {
      throw new Error("close requires pid OR title OR processName");
    }
    const result = await closeWindow({ pid, title, processName, force });
    appendAudit("window_control", { action, pid, title, processName, force, closed: result.closed });
    return result;
  }
  if (action === "discover") {
    const limit = typeof body.limit === "number" ? Math.max(1, Math.min(100, Math.trunc(body.limit))) : 30;
    const filter = optionalAliasString(body, ["query", "filter", "target", "application", "appName", "name"]);
    const apps = await discoverInstalledApps(filter, limit);
    return { ok: true, count: apps.length, apps };
  }
  throw new Error("action must be list, focus, launch, close, or discover");
}

// Gracefully ask a window to close (WM_CLOSE), fall back to Stop-Process
// after a short wait when `force=true` or when WM_CLOSE didn't take.
async function closeWindow(params: {
  pid: number | null;
  title?: string;
  processName?: string;
  force: boolean;
}): Promise<JsonRecord> {
  const psSafePid = params.pid !== null ? params.pid : "$null";
  const psSafeTitle = JSON.stringify(params.title ?? "");
  const psSafeProc = JSON.stringify(params.processName ?? "");
  const force = params.force ? "$true" : "$false";
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LuminaWindowClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public const uint WM_CLOSE = 0x0010;
}
"@
$targetPid = ${psSafePid}
$title = ${psSafeTitle}
$procName = ${psSafeProc}
$force = ${force}
$matched = @()
if ($targetPid -ne $null -and $targetPid -gt 0) {
  try { $matched += Get-Process -Id $targetPid -ErrorAction Stop } catch {}
} elseif ($procName) {
  try { $matched += @(Get-Process -Name ($procName -replace '\\.exe$','') -ErrorAction SilentlyContinue) } catch {}
} elseif ($title) {
  $needle = $title.ToLower()
  try { $matched += @(Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.ToLower().Contains($needle) }) } catch {}
}
$matched = $matched | Where-Object { $_ -ne $null } | Sort-Object -Property Id -Unique
if ($matched.Count -eq 0) {
  [PSCustomObject]@{ ok=$false; closed=$false; error="no matching window"; matched=0 } | ConvertTo-Json -Compress
  exit 0
}
$closed = 0
foreach ($p in $matched) {
  $hwnd = $p.MainWindowHandle
  if ($hwnd -ne 0 -and -not $force) {
    [LuminaWindowClose]::PostMessage($hwnd, [LuminaWindowClose]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  }
}
Start-Sleep -Milliseconds 1500
foreach ($p in $matched) {
  try {
    $alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
    if ($alive) {
      if ($force) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { $closed++ }
      }
    } else {
      $closed++
    }
  } catch { $closed++ }
}
[PSCustomObject]@{ ok=$true; closed=($closed -gt 0); count=$matched.Count; killed=$closed; force=$force } | ConvertTo-Json -Compress
`;
  const stdout = await runPowerShell(script, 12_000);
  try {
    return JSON.parse(stdout || "{}") as JsonRecord;
  } catch {
    return { ok: false, closed: false, error: "invalid_close_response", raw: stdout };
  }
}

async function fuzzyLaunchFromStart(query: string): Promise<JsonRecord> {
  const safe = JSON.stringify(query);
  const ps = `
$needle = (${safe}).ToLower()
$apps = @(Get-StartApps -ErrorAction SilentlyContinue)
$matches = @($apps | Where-Object { $_.Name -and $_.Name.ToLower().Contains($needle) })
if ($matches.Count -eq 0) {
  [PSCustomObject]@{ ok=$false; error="no_match"; query=$needle } | ConvertTo-Json -Compress
  exit 0
}
$pick = $matches[0]
foreach ($m in $matches) {
  if ($m.Name.ToLower() -eq $needle) { $pick = $m; break }
}
$shell = "shell:appsFolder\\$($pick.AppID)"
Start-Process -FilePath "explorer.exe" -ArgumentList $shell
$alts = @($matches | Select-Object -First 5 | ForEach-Object { @{ name=$_.Name; appId=$_.AppID } })
[PSCustomObject]@{ ok=$true; launched=$true; via="start_apps"; picked=@{ name=$pick.Name; appId=$pick.AppID }; alternativeCount=$matches.Count; alternatives=$alts } | ConvertTo-Json -Compress -Depth 4
`;
  const stdout = await runPowerShell(ps, 15_000);
  try {
    return JSON.parse(stdout || "{}") as JsonRecord;
  } catch {
    return { ok: false, error: "invalid_fuzzy_response", raw: stdout };
  }
}

async function discoverInstalledApps(filter: string | undefined, limit: number): Promise<JsonValue[]> {
  const filterPs = filter ? JSON.stringify(filter.toLowerCase()) : "$null";
  const ps = `
$filter = ${filterPs}
$apps = @(Get-StartApps -ErrorAction SilentlyContinue) | Where-Object { $_.Name }
if ($filter) {
  $apps = $apps | ForEach-Object {
    $name = "$($_.Name)"
    $appId = "$($_.AppID)"
    $lowerName = $name.ToLower()
    $lowerAppId = $appId.ToLower()
    $score = 999
    if ($lowerName -eq $filter) { $score = 0 }
    elseif ($lowerAppId -eq $filter) { $score = 1 }
    elseif ($lowerName.StartsWith($filter)) { $score = 2 }
    elseif ($lowerName.Contains($filter)) { $score = 3 }
    elseif ($lowerAppId.Contains($filter)) { $score = 4 }
    if ($score -lt 999) {
      [PSCustomObject]@{ Name=$name; AppID=$appId; Score=$score }
    }
  }
  $apps = $apps | Sort-Object -Property Score,Name
} else {
  $apps = $apps | Sort-Object -Property Name
}
$apps = $apps | Select-Object -First ${limit}
$apps | ForEach-Object { [PSCustomObject]@{ name=$_.Name; appId=$_.AppID; score=if ($null -ne $_.Score) { $_.Score } else { $null } } } | ConvertTo-Json -Compress -Depth 3
`;
  const stdout = await runPowerShell(ps, 12_000);
  try {
    const parsed = JSON.parse(stdout || "[]") as JsonValue;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function handleScreenshot(): Promise<JsonRecord> {
  const outDir = resolve(runtimeDir, "screenshots");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `screenshot-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save(${JSON.stringify(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
  await runPowerShell(ps, 30_000);
  appendAudit("screenshot", { path: outPath });
  return { ok: true, path: outPath };
}

async function handleInput(body: JsonRecord): Promise<JsonRecord> {
  const kind = stringBody(body, "kind");
  appendAudit("input", { kind });
  // AMSI-safe path: translate the legacy kind-based input to the win_input.py
  // ctypes sidecar. mouse_move needs no allowlist; key/text/click target the
  // foreground, so require allowedApps (default to foreground-agnostic when the
  // caller passes none for these simple legacy verbs).
  {
    const allowed = Array.isArray(body.allowedApps) ? body.allowedApps : [];
    let native: JsonRecord | null = null;
    if (kind === "mouse_move") {
      native = { action: "mouse_move", x: body.x, y: body.y } as JsonRecord;
    } else if (kind === "click") {
      native = { action: "mouse_click", button: "left", allowedApps: allowed } as JsonRecord;
    } else if (kind === "key" || kind === "text") {
      native = { action: "type_text", text: body.value, allowedApps: allowed } as JsonRecord;
    }
    if (native) {
      const r = await runPythonSidecar(winInputSidecar, ["--json", JSON.stringify(native)], 12_000);
      if (r.error !== "sidecar_missing") return r;
    }
  }
  if (kind === "key" || kind === "text") {
    const value = stringBody(body, "value");
    const escaped = value.replace(/[+^%~(){}\[\]]/gu, "{$&}");
    await runPowerShell(`$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys(${JSON.stringify(escaped)})`);
    return { ok: true };
  }
  if (kind === "mouse_move") {
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers");
    await runPowerShell(`
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);' -Name NativeMouse -Namespace Lumina
[Lumina.NativeMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
`);
    return { ok: true };
  }
  if (kind === "click") {
    await runPowerShell(`
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);' -Name NativeMouse -Namespace Lumina
[Lumina.NativeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[Lumina.NativeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`);
    return { ok: true };
  }
  throw new Error("kind must be key, text, mouse_move, or click");
}

async function handleInputControl(body: JsonRecord): Promise<JsonRecord> {
  const action = stringBody(body, "action");
  const allowedApps = Array.isArray(body.allowedApps)
    ? body.allowedApps.filter((value): value is string => typeof value === "string")
    : [];
  // AMSI-safe path: input runs via the win_input.py ctypes SendInput sidecar.
  // Bitdefender blocks the PowerShell Add-Type SendInput below. The sidecar
  // enforces the same allowlist guard (foreground process must be allowlisted).
  const nativeInput = await runPythonSidecar(winInputSidecar, ["--json", JSON.stringify(body)], 15_000);
  if (nativeInput.error !== "sidecar_missing") {
    appendAudit("input_control", { action, ok: nativeInput.ok === true, via: "python" });
    return nativeInput;
  }
  if (allowedApps.length === 0) {
    return { ok: false, allowed: false, error: "input_app_allowlist_empty" };
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
  const ps = `
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${payload}")) | ConvertFrom-Json
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class LuminaInputBridge {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint flags;
    public uint time; public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort virtualKey; public ushort scanCode; public uint flags;
    public uint time; public UIntPtr extraInfo;
  }

  public static string ForegroundProcess() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); }
    catch { return ""; }
  }

  public static void Click(string button, int count) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    for (int i = 0; i < count; i++) {
      SendMouse(down);
      SendMouse(up);
    }
  }

  // Vertical (dy) and horizontal (dx) wheel scroll. Units are WHEEL_DELTA
  // (= 120 per notch). Positive dy = scroll up, negative = down.
  public static void Scroll(int dx, int dy) {
    if (dy != 0) SendMouseData(0x0800u, (uint)dy);   // MOUSEEVENTF_WHEEL
    if (dx != 0) SendMouseData(0x1000u, (uint)dx);   // MOUSEEVENTF_HWHEEL
  }

  // Press + interpolated-move + release. Steps the cursor between the two
  // anchors so apps that listen to WM_MOUSEMOVE (sliders, kanban cards,
  // canvas tools) get a believable drag rather than a teleport.
  public static void Drag(int x1, int y1, int x2, int y2, string button, int steps, int stepDelayMs) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    SetCursorPos(x1, y1);
    SendMouse(down);
    if (steps < 2) steps = 2;
    for (int i = 1; i <= steps; i++) {
      int ix = x1 + (int)((long)(x2 - x1) * i / steps);
      int iy = y1 + (int)((long)(y2 - y1) * i / steps);
      SetCursorPos(ix, iy);
      if (stepDelayMs > 0) System.Threading.Thread.Sleep(stepDelayMs);
    }
    SendMouse(up);
  }

  public static void Chord(ushort[] keys) {
    foreach (ushort key in keys) SendKey(key, false);
    for (int i = keys.Length - 1; i >= 0; i--) SendKey(keys[i], true);
  }

  public static void TypeText(string text) {
    foreach (char value in text) {
      SendUnicode(value, false);
      SendUnicode(value, true);
    }
  }

  static void SendMouse(uint flags) {
    INPUT input = new INPUT {
      type = 0,
      data = new INPUTUNION {
        mouse = new MOUSEINPUT { flags = flags }
      }
    };
    Send(new INPUT[] { input });
  }

  static void SendMouseData(uint flags, uint data) {
    INPUT input = new INPUT {
      type = 0,
      data = new INPUTUNION {
        mouse = new MOUSEINPUT { mouseData = data, flags = flags }
      }
    };
    Send(new INPUT[] { input });
  }

  static void SendKey(ushort virtualKey, bool keyUp) {
    INPUT input = new INPUT {
      type = 1,
      data = new INPUTUNION {
        keyboard = new KEYBDINPUT { virtualKey = virtualKey, flags = keyUp ? 0x0002u : 0u }
      }
    };
    Send(new INPUT[] { input });
  }

  static void SendUnicode(char value, bool keyUp) {
    INPUT input = new INPUT {
      type = 1,
      data = new INPUTUNION {
        keyboard = new KEYBDINPUT {
          scanCode = value,
          flags = 0x0004u | (keyUp ? 0x0002u : 0u)
        }
      }
    };
    Send(new INPUT[] { input });
  }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != (uint)inputs.Length) throw new InvalidOperationException("Windows rejected the input.");
  }
}
"@
$vk = @{
  BACKSPACE=0x08; TAB=0x09; ENTER=0x0d; SHIFT=0x10; CTRL=0x11; ALT=0x12; ESC=0x1b; SPACE=0x20;
  PAGEUP=0x21; PAGEDOWN=0x22; END=0x23; HOME=0x24; LEFT=0x25; UP=0x26; RIGHT=0x27; DOWN=0x28;
  DELETE=0x2e; WIN=0x5b; F1=0x70; F2=0x71; F3=0x72; F4=0x73; F5=0x74; F6=0x75; F7=0x76;
  F8=0x77; F9=0x78; F10=0x79; F11=0x7a; F12=0x7b
}
for ($i = 48; $i -le 57; $i++) { $vk["$([char]$i)"] = $i }
for ($i = 65; $i -le 90; $i++) { $vk["$([char]$i)"] = $i }
$processName = [LuminaInputBridge]::ForegroundProcess()
$allowed = @($payload.allowedApps | ForEach-Object { "$_".ToLowerInvariant() }) -contains $processName
if (-not $allowed) {
  [PSCustomObject]@{ ok=$false; allowed=$false; error="foreground_app_not_allowed"; processName=$processName; action=$payload.action } | ConvertTo-Json -Compress
  exit 0
}
switch ($payload.action) {
  "mouse_move" {
    [LuminaInputBridge]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null
  }
  "mouse_click" {
    if ($null -ne $payload.x -and $null -ne $payload.y) {
      [LuminaInputBridge]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null
    }
    $button = "$($payload.button)"
    $clicks = [Math]::Max(1, [int]$payload.clicks)
    [LuminaInputBridge]::Click($button, $clicks)
  }
  "type_text" {
    [LuminaInputBridge]::TypeText("$($payload.text)")
  }
  "key_press" {
    $keys = @($payload.keys | ForEach-Object { "$_".ToUpperInvariant() })
    if ($keys.Count -ne 1 -or -not $vk.ContainsKey($keys[0])) { throw "unsupported key: $($keys -join ',')" }
    [LuminaInputBridge]::Chord([UInt16[]]@([UInt16]$vk[$keys[0]]))
  }
  "shortcut" {
    $keys = @($payload.keys | ForEach-Object { "$_".ToUpperInvariant() })
    $codes = @()
    foreach ($key in $keys) {
      if (-not $vk.ContainsKey($key)) { throw "unsupported key: $key" }
      $codes += [UInt16]$vk[$key]
    }
    [LuminaInputBridge]::Chord([UInt16[]]$codes)
  }
  "mouse_scroll" {
    if ($null -ne $payload.x -and $null -ne $payload.y) {
      [LuminaInputBridge]::SetCursorPos([int]$payload.x, [int]$payload.y) | Out-Null
    }
    $dx = if ($null -ne $payload.dx) { [int]$payload.dx } else { 0 }
    $dy = if ($null -ne $payload.dy) { [int]$payload.dy } else { 0 }
    [LuminaInputBridge]::Scroll($dx, $dy)
  }
  "mouse_drag" {
    if ($null -eq $payload.x1 -or $null -eq $payload.y1 -or $null -eq $payload.x2 -or $null -eq $payload.y2) {
      throw "mouse_drag requires x1, y1, x2, y2"
    }
    $button = if ($null -ne $payload.button) { "$($payload.button)" } else { "left" }
    $steps = if ($null -ne $payload.steps) { [int]$payload.steps } else { 24 }
    $stepDelay = if ($null -ne $payload.step_delay_ms) { [int]$payload.step_delay_ms } else { 8 }
    [LuminaInputBridge]::Drag([int]$payload.x1, [int]$payload.y1, [int]$payload.x2, [int]$payload.y2, $button, $steps, $stepDelay)
  }
  default { throw "unsupported input action: $($payload.action)" }
}
$waitMs = if ($null -ne $payload.wait_ms) { [int]$payload.wait_ms } else { 100 }
Start-Sleep -Milliseconds $waitMs
[PSCustomObject]@{ ok=$true; allowed=$true; processName=$processName; action=$payload.action } | ConvertTo-Json -Compress
`;
  const stdout = await runPowerShell(ps, 15_000);
  appendAudit("input_control", { action });
  return JSON.parse(stdout || "{}") as JsonRecord;
}

async function handleLogs(): Promise<JsonRecord> {
  if (!existsSync(auditLog)) return { ok: true, lines: [] };
  const raw = readFileSync(auditLog, "utf8");
  return { ok: true, lines: raw.trim().split(/\r?\n/u).slice(-100) };
}

function isPerceptionRunning(): boolean {
  return perceptionProcess !== undefined && perceptionProcess.exitCode === null;
}

function startPerceptionSidecar(options: {
  fps?: number;
  threshold?: number;
  saveFrames?: boolean;
  restart?: boolean;
} = {}): JsonRecord {
  assertWindows();

  if (options.restart && isPerceptionRunning()) {
    stopPerceptionSidecar();
  }

  if (isPerceptionRunning()) {
    return {
      ok: true,
      running: true,
      pid: perceptionProcess?.pid ?? null,
      startedAt,
      perceptionStartedAt,
      perceptionLastEventAt,
      perceptionStatePath,
      message: "perception_already_running",
    };
  }

  if (!existsSync(perceptionSidecar)) {
    return {
      ok: false,
      running: false,
      error: "perception_sidecar_missing",
      script: perceptionSidecar,
    };
  }

  mkdirSync(dirname(perceptionStatePath), { recursive: true });
  const rawFps = Number(options.fps ?? process.env.LUMINA_PERCEPTION_FPS);
  const rawThreshold = Number(options.threshold ?? process.env.LUMINA_PERCEPTION_THRESHOLD);
  const fps = Math.min(Math.max(Number.isFinite(rawFps) ? rawFps : 2, 0.5), 10);
  const threshold = Math.min(Math.max(Number.isFinite(rawThreshold) ? rawThreshold : 0.01, 0.001), 0.5);
  const shouldSaveFrames = options.saveFrames ?? process.env.LUMINA_PERCEPTION_SAVE_FRAMES === "true";
  const outDir = resolve(runtimeDir, "perception", "frames");
  const argv = [
    "-X",
    "utf8",
    perceptionSidecar,
    "--fps",
    String(fps),
    "--threshold",
    String(threshold),
    "--latest-state",
    perceptionStatePath,
    "--out-dir",
    outDir,
  ];
  if (shouldSaveFrames) {
    argv.push("--save-frames");
  }

  const child = spawn(pythonExe, argv, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  perceptionProcess = child;
  perceptionStartedAt = Date.now();
  perceptionLastEventAt = 0;
  perceptionLastLine = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      perceptionLastEventAt = Date.now();
      perceptionLastLine = trimmed.slice(0, 2000);
      appendAudit("perception_event", { line: perceptionLastLine });
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const line = chunk.trim();
    if (line) {
      appendAudit("perception_stderr", { line: line.slice(0, 2000) });
    }
  });

  child.on("exit", (code, signal) => {
    appendAudit("perception_exit", { code: code ?? null, signal: signal ?? null });
    if (perceptionProcess === child) {
      perceptionProcess = undefined;
    }
  });

  appendAudit("perception_start", {
    pid: child.pid ?? null,
    fps,
    threshold,
    saveFrames: shouldSaveFrames,
    latestState: perceptionStatePath,
  });

  return {
    ok: true,
    running: true,
    pid: child.pid ?? null,
    perceptionStartedAt,
    perceptionStatePath,
    fps,
    threshold,
    saveFrames: shouldSaveFrames,
  };
}

function stopPerceptionSidecar(): JsonRecord {
  const child = perceptionProcess;
  if (!child || child.exitCode !== null) {
    perceptionProcess = undefined;
    return {
      ok: true,
      running: false,
      message: "perception_not_running",
      perceptionStatePath,
    };
  }

  try {
    child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
  } catch {
    /* process may already be closing */
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  }, 1200).unref();

  appendAudit("perception_stop", { pid: child.pid ?? null });
  return {
    ok: true,
    running: false,
    stopping: true,
    pid: child.pid ?? null,
    perceptionStatePath,
  };
}

function handlePerceptionControl(body: JsonRecord): JsonRecord {
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "status";

  if (action === "start") {
    return startPerceptionSidecar({
      fps: typeof body.fps === "number" ? body.fps : undefined,
      threshold: typeof body.threshold === "number" ? body.threshold : undefined,
      saveFrames: body.saveFrames === true,
    });
  }

  if (action === "restart") {
    return startPerceptionSidecar({
      fps: typeof body.fps === "number" ? body.fps : undefined,
      threshold: typeof body.threshold === "number" ? body.threshold : undefined,
      saveFrames: body.saveFrames === true,
      restart: true,
    });
  }

  if (action === "stop") {
    return stopPerceptionSidecar();
  }

  if (action !== "status") {
    return {
      ok: false,
      error: "perception_control_action_must_be_start_stop_restart_or_status",
      action,
    };
  }

  return {
    ok: true,
    running: isPerceptionRunning(),
    pid: perceptionProcess?.pid ?? null,
    perceptionStartedAt,
    perceptionLastEventAt,
    perceptionLastLine,
    perceptionStatePath,
    stateExists: existsSync(perceptionStatePath),
  };
}

// Lumina's current sight: the latest semantic perception snapshot (foreground
// app + actionable UIA elements with coords), refreshed continuously by the
// perception sidecar. Returns ok:false when perception hasn't started yet.
async function handlePerception(): Promise<JsonRecord> {
  if (!isPerceptionRunning()) {
    startPerceptionSidecar();
  }

  if (!existsSync(perceptionStatePath)) {
    return {
      ok: false,
      error: "perception_starting",
      running: isPerceptionRunning(),
      pid: perceptionProcess?.pid ?? null,
      path: perceptionStatePath,
    };
  }
  try {
    const raw = readFileSync(perceptionStatePath, "utf8");
    const parsed = JSON.parse(raw) as JsonRecord;
    return {
      ...parsed,
      perceptionDaemon: {
        running: isPerceptionRunning(),
        pid: perceptionProcess?.pid ?? null,
        startedAt: perceptionStartedAt,
        lastEventAt: perceptionLastEventAt,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── UI Automation (native accessibility) ─────────────────────────────────────
// The bridge exposes Lumina's "hands + eyes" on the Windows UI tree by shelling
// out to the Python UIA sidecars. This is what lets Lumina Code act on elements
// by identity (ClickElement(Name="…")) instead of blind coordinates, wait for a
// control to appear, and see screen + structure + text in one call.

// Parse the last non-empty stdout line as JSON. The sidecars print exactly one
// JSON object; on graceful failure uia_tree.py exits 2 but still emits JSON, so
// we recover it from the thrown error's captured stdout.
function parseSidecarJson(text: string): JsonRecord | undefined {
  const lastLine = text.trim().split(/\r?\n/u).filter(Boolean).pop() ?? "";
  if (!lastLine) return undefined;
  try {
    const parsed = JSON.parse(lastLine) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonRecord;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

async function runPythonSidecar(
  script: string,
  argv: string[],
  timeoutMs = 20_000,
): Promise<JsonRecord> {
  assertWindows();
  if (!existsSync(script)) {
    return { ok: false, error: "sidecar_missing", script };
  }
  try {
    const { stdout } = await execFileAsync(pythonExe, ["-X", "utf8", script, ...argv], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseSidecarJson(stdout) ?? { ok: false, error: "sidecar_bad_output", raw: stdout.slice(0, 2000) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    const recovered = parseSidecarJson(err.stdout ?? "");
    if (recovered) return recovered;
    return {
      ok: false,
      error: err.killed ? "sidecar_timeout" : "sidecar_failed",
      detail: (err.stderr ?? "").trim().slice(0, 500) || err.message || String(error),
    };
  }
}

function pushPidArg(argv: string[], body: JsonRecord): void {
  if (body.pid !== undefined && body.pid !== null) {
    argv.push("--pid", String(boundedInt(body.pid, 0, 0, 2_000_000)));
  }
}

function pushWindowTargetArgs(argv: string[], body: JsonRecord): void {
  pushPidArg(argv, body);

  if (body.hwnd !== undefined && body.hwnd !== null) {
    argv.push("--hwnd", String(boundedInt(body.hwnd, 0, 0, Number.MAX_SAFE_INTEGER)));
  }

  const title = optionalAliasString(body, ["title", "windowTitle", "targetTitle"]);
  if (title) {
    argv.push("--title", title);
  }

  const processName = optionalAliasString(body, ["processName", "process", "targetProcess"]);
  if (processName) {
    argv.push("--process-name", processName);
  }
}

// POST /ui_inspect — accessibility tree of the foreground (or --pid) window.
// With { query } it fuzzy-resolves a natural-language target to ranked matches;
// without, it returns the full interactable element tree with bbox + center.
async function handleUiInspect(body: JsonRecord): Promise<JsonRecord> {
  const argv: string[] = [];
  pushWindowTargetArgs(argv, body);
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query) argv.push("--find", query);
  const controlType = typeof body.controlType === "string" ? body.controlType.trim() : "";
  if (controlType) argv.push("--control-type", controlType);
  argv.push("--max-depth", String(boundedInt(body.maxDepth, 6, 1, 20)));
  argv.push("--max-nodes", String(boundedInt(body.maxNodes, 400, 20, 2000)));
  if (query) argv.push("--max-matches", String(boundedInt(body.maxMatches, 5, 1, 25)));
  const result = await runPythonSidecar(uiaSidecar, argv, 20_000);
  appendAudit("ui_inspect", { pid: (body.pid as JsonValue) ?? null, query: query || null, ok: result.ok === true });
  return result;
}

// POST /ui_interact — act on an element by identity (AutomationId/Name) via
// native UIA patterns: invoke | click | set_value | toggle | select | focus.
// Works even off-screen / not-foreground, and never guesses coordinates.
async function handleUiInteract(body: JsonRecord): Promise<JsonRecord> {
  const automationId = typeof body.automationId === "string" ? body.automationId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!automationId && !name) {
    return { ok: false, error: "ui_interact_requires_automationId_or_name" };
  }
  const argv = ["--invoke"];
  pushWindowTargetArgs(argv, body);
  if (automationId) argv.push("--automation-id", automationId);
  if (name) argv.push("--name", name);
  const action =
    typeof body.action === "string" && body.action.trim() ? body.action.trim().toLowerCase() : "invoke";
  argv.push("--action", action);
  if (typeof body.value === "string") argv.push("--value", body.value);
  const controlType = typeof body.controlType === "string" ? body.controlType.trim() : "";
  if (controlType) argv.push("--control-type", controlType);
  if (body.nameMatch === "exact") argv.push("--name-match", "exact");
  // Partial/reordered name resolution (e.g. "Sandra" -> "Sandra Patricia").
  if (body.fuzzyMatch === true) argv.push("--fuzzy");
  // Poll for the element before acting, to avoid load races.
  const waitMs = boundedInt(body.waitForElementMs ?? body.timeoutMs, 0, 0, 30_000);
  if (waitMs > 0) argv.push("--pre-wait", String(waitMs / 1000));
  // Submit key after acting, for apps whose Send button is not in the UIA tree.
  const thenPress =
    typeof body.thenPress === "string" ? body.thenPress.trim().toLowerCase() : "";
  if (thenPress === "enter" || thenPress === "tab" || thenPress === "escape") {
    argv.push("--then-press", thenPress);
  }
  const result = await runPythonSidecar(uiaSidecar, argv, waitMs + 15_000);
  appendAudit("ui_interact", {
    automationId: automationId || null,
    name: name || null,
    action,
    fuzzy: body.fuzzyMatch === true,
    thenPress: thenPress || null,
    ok: result.ok === true,
  });
  return result;
}

// POST /ui_wait — poll until a target element appears (or timeout). Lets Lumina
// wait for a slow-loading control before acting instead of firing blind.
async function handleUiWait(body: JsonRecord): Promise<JsonRecord> {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const automationId = typeof body.automationId === "string" ? body.automationId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!query && !automationId && !name) {
    return { ok: false, error: "ui_wait_requires_query_name_or_automationId" };
  }
  const timeoutMs = boundedInt(body.timeoutMs, 8000, 200, 60_000);
  const intervalMs = boundedInt(body.intervalMs, 400, 50, 5000);
  const argv = ["--wait", "--timeout", String(timeoutMs / 1000), "--interval", String(intervalMs / 1000)];
  pushWindowTargetArgs(argv, body);
  if (query) argv.push("--find", query);
  if (automationId) argv.push("--automation-id", automationId);
  if (name) argv.push("--name", name);
  const controlType = typeof body.controlType === "string" ? body.controlType.trim() : "";
  if (controlType) argv.push("--control-type", controlType);
  if (body.nameMatch === "exact") argv.push("--name-match", "exact");
  const result = await runPythonSidecar(uiaSidecar, argv, timeoutMs + 5000);
  appendAudit("ui_wait", { query: query || null, name: name || null, appeared: result.appeared === true });
  return result;
}

// POST /ui_capture — screenshot + UIA structure + OCR text in one call, so
// Lumina can "see" a window (including Chromium/canvas apps with opaque trees).
async function handlePhoneLinkStatus(): Promise<JsonRecord> {
  const result = await runPythonSidecar(phoneLinkSidecar, ["--status"], 15_000);
  appendAudit("phone_link_status", {
    ok: result.ok === true,
    running: result.running === true,
    connected: result.connected === true,
  });
  return result;
}

async function handleNotifications(body: JsonRecord): Promise<JsonRecord> {
  const limit = boundedInt(body.limit, 50, 1, 200);
  const argv = ["--limit", String(limit)];
  const application = optionalAliasString(body, ["application", "app", "source"]);
  if (application) argv.push("--app", application);
  if (body.includeHidden === false) argv.push("--visible-only");
  const result = await runPythonSidecar(notificationCenterSidecar, argv, 40_000);
  appendAudit("notifications_list", {
    ok: result.ok === true,
    count: typeof result.count === "number" ? result.count : null,
    filtered: Boolean(application),
  });
  return result;
}

async function handleNotificationsDismiss(body: JsonRecord): Promise<JsonRecord> {
  const application = optionalAliasString(body, ["application", "app", "source"]);
  const match = optionalAliasString(body, ["match", "title", "text", "query"]);
  const dismissAll = body.all === true || body.dismissAll === true;
  if (!application && !match && !dismissAll) {
    return {
      ok: false,
      error: "specify application, match, or all=true to choose what to dismiss",
    };
  }
  const maxDismiss = boundedInt(body.maxDismiss, 25, 1, 200);
  const argv = ["--mode", "dismiss", "--max-dismiss", String(maxDismiss)];
  if (application) argv.push("--app", application);
  if (match) argv.push("--match", match);
  if (dismissAll) argv.push("--all");
  const result = await runPythonSidecar(notificationCenterSidecar, argv, 40_000);
  appendAudit("notifications_dismiss", {
    ok: result.ok === true,
    clearedAll: result.clearedAll === true,
    dismissedCount: typeof result.dismissedCount === "number" ? result.dismissedCount : null,
    filtered: Boolean(application),
    matched: Boolean(match),
  });
  return result;
}

// POST /notifications/live — snapshot of current toast notifications via the
// WinRT UserNotificationListener. Unlike /notifications (UI Automation) this
// opens NO window and steals no focus, so Start Talk can poll it every couple of
// seconds to detect arrivals. Read-only; audited sparingly to avoid poll spam.
async function handleNotificationsLive(): Promise<JsonRecord> {
  return await runPythonSidecar(notificationListenerSidecar, [], 20_000);
}

// POST /voice/claude-response — Claude Code's Stop hook enqueues a finished chat
// response for Start Talk to read aloud. Text-only, localhost-only, capped.
function handleVoiceClaudeEnqueue(body: JsonRecord): JsonRecord {
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 6000) : "";
  if (!text) {
    return { ok: false, error: "text_required" };
  }
  claudeVoiceSeq += 1;
  const id =
    typeof body.requestId === "string" && body.requestId.trim()
      ? body.requestId.trim().slice(0, 120)
      : `claude:${Date.now()}:${claudeVoiceSeq}`;
  claudeVoiceQueue.push({ id, text, createdAt: Date.now() });
  while (claudeVoiceQueue.length > CLAUDE_VOICE_MAX_QUEUE) {
    claudeVoiceQueue.shift();
  }
  appendAudit("voice_claude_enqueue", { id, length: text.length });
  return { ok: true, id, queued: claudeVoiceQueue.length };
}

// POST /voice/claude-response/pending — Lumina Core drains queued responses.
// Returns and clears items younger than the TTL; stale items are dropped silently
// so the voice never reads an answer that is minutes old.
function handleVoiceClaudePending(): JsonRecord {
  const now = Date.now();
  const fresh: JsonValue[] = [];
  for (const item of claudeVoiceQueue) {
    if (now - item.createdAt <= CLAUDE_VOICE_TTL_MS) {
      fresh.push({ id: item.id, text: item.text, createdAt: item.createdAt });
    }
  }
  claudeVoiceQueue.length = 0;
  return { ok: true, responses: fresh };
}

async function handlePhoneLinkReply(body: JsonRecord): Promise<JsonRecord> {
  const validation = validatePhoneLinkReplyRequest(body);
  if (validation.ok === false) {
    appendAudit("phone_link_reply_blocked", { error: validation.error });
    return { ok: false, error: validation.error };
  }

  const request = validation.request;
  const argv = [
    "--reply",
    "--notification-id",
    request.notificationId,
    "--mobile-app",
    request.mobileApp,
    "--sender",
    request.sender,
    "--message",
    request.message,
    "--reply-text",
    request.replyText,
  ];
  if (request.dryRun) argv.push("--dry-run");

  const result = await runPythonSidecar(phoneLinkSidecar, argv, 25_000);
  appendAudit("phone_link_reply", {
    notificationId: request.notificationId,
    mobileApp: request.mobileApp,
    dryRun: request.dryRun,
    ok: result.ok === true,
    verified: result.verified === true,
    error: typeof result.error === "string" ? result.error : null,
    senderLength: request.sender.length,
    sourceMessageLength: request.message.length,
    replyLength: request.replyText.length,
  });
  return result;
}

async function ensureWhatsappRunning(): Promise<void> {
  const windows = await runPythonSidecar(
    winWindowSidecar,
    ["--action", "list", "--json", "{}"],
    10_000,
  );
  const hasWhatsapp =
    Array.isArray(windows.windows) &&
    windows.windows.some((window: unknown) => {
      if (!window || typeof window !== "object" || Array.isArray(window)) {
        return false;
      }
      const record = window as Record<string, unknown>;
      const process =
        typeof record.process === "string" ? record.process.toLowerCase() : "";
      const title =
        typeof record.title === "string" ? record.title.toLowerCase() : "";
      return (
        process.includes("whatsapp") ||
        ((process.includes("msedge") || process.includes("webview")) &&
          title.includes("whatsapp"))
      );
    });

  if (hasWhatsapp) {
    return;
  }

  appendAudit("whatsapp", {
    action: "auto_launch",
    reason: "whatsapp_not_running",
  });
  const launched = await launchApplicationTarget("WhatsApp", {
    timeoutMs: 10_000,
    waitForWindow: true,
  });
  if (launched.ok !== true) {
    throw new Error("whatsapp_auto_launch_failed");
  }
  await sleep(2_500);
}

function pushWhatsappWindowArg(argv: string[], body: JsonRecord): void {
  const window = typeof body.window === "string" ? body.window.trim() : "";
  if (window) argv.push("--window", window);
}

// POST /whatsapp/contacts - list conversations, unread metadata, and previews,
// or use WhatsApp's own search box to identify a contact by name.
async function handleWhatsappContacts(body: JsonRecord): Promise<JsonRecord> {
  await ensureWhatsappRunning();
  const argv = ["--contacts"];
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query) argv.push("--query", query);
  argv.push("--limit", String(boundedInt(body.limit, 40, 1, 200)));
  if (body.unreadOnly === true) argv.push("--unread-only");
  if (body.includePreviews === false) argv.push("--no-previews");
  pushWhatsappWindowArg(argv, body);
  const result = await runPythonSidecar(whatsappSidecar, argv, 45_000);
  appendAudit("whatsapp_contacts", {
    ok: result.ok === true,
    host: typeof result.host === "string" ? result.host : null,
    count: typeof result.count === "number" ? result.count : null,
    searched: Boolean(query),
    unreadOnly: body.unreadOnly === true,
  });
  return result;
}

// POST /whatsapp/messages - read recent bubbles with sender, time, and delivery.
async function handleWhatsappMessages(body: JsonRecord): Promise<JsonRecord> {
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  if (!contact) {
    return { ok: false, error: "whatsapp_messages_requires_contact" };
  }
  await ensureWhatsappRunning();
  const argv = [
    "--messages",
    "--contact",
    contact,
    "--limit",
    String(boundedInt(body.limit, 40, 1, 100)),
  ];
  pushWhatsappWindowArg(argv, body);
  const result = await runPythonSidecar(whatsappSidecar, argv, 60_000);
  appendAudit("whatsapp_messages", {
    ok: result.ok === true,
    host: typeof result.host === "string" ? result.host : null,
    count: typeof result.count === "number" ? result.count : null,
    contactLength: contact.length,
    error: typeof result.error === "string" ? result.error : null,
  });
  return result;
}

// POST /whatsapp/reply - send text or a local attachment to a resolved contact.
async function handleWhatsappReply(body: JsonRecord): Promise<JsonRecord> {
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const mediaPath =
    typeof body.mediaPath === "string" ? body.mediaPath.trim() : "";
  if (!contact || (!message && !mediaPath)) {
    return { ok: false, error: "whatsapp_reply_requires_contact_and_content" };
  }
  if (message.length > 4_096) {
    return { ok: false, error: "message_too_long" };
  }

  await ensureWhatsappRunning();
  const argv = ["--reply", "--contact", contact];
  if (message) argv.push("--message", message);
  if (mediaPath) argv.push("--media", mediaPath);
  pushWhatsappWindowArg(argv, body);
  if (body.dryRun === true) argv.push("--dry-run");
  const result = await runPythonSidecar(
    whatsappSidecar,
    argv,
    mediaPath ? 120_000 : 60_000,
  );
  appendAudit("whatsapp_reply", {
    ok: result.ok === true,
    host: typeof result.host === "string" ? result.host : null,
    dryRun: body.dryRun === true,
    verified: result.verified === true,
    submit: typeof result.submit === "string" ? result.submit : null,
    hasMedia: Boolean(mediaPath),
    contactLength: contact.length,
    messageLength: message.length,
    error: typeof result.error === "string" ? result.error : null,
  });
  return result;
}

// POST /whatsapp/statuses - list authors without opening individual statuses.
async function handleWhatsappStatuses(body: JsonRecord): Promise<JsonRecord> {
  await ensureWhatsappRunning();
  const argv = [
    "--statuses",
    "--limit",
    String(boundedInt(body.limit, 40, 1, 200)),
  ];
  pushWhatsappWindowArg(argv, body);
  const result = await runPythonSidecar(whatsappSidecar, argv, 60_000);
  appendAudit("whatsapp_statuses", {
    ok: result.ok === true,
    host: typeof result.host === "string" ? result.host : null,
    count: typeof result.count === "number" ? result.count : null,
  });
  return result;
}

// POST /whatsapp/status - publish media, or render text to an image first.
async function handleWhatsappStatus(body: JsonRecord): Promise<JsonRecord> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const mediaPath =
    typeof body.mediaPath === "string" ? body.mediaPath.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  const background =
    typeof body.background === "string" ? body.background.trim() : "";
  if (!text && !mediaPath) {
    return { ok: false, error: "whatsapp_status_requires_text_or_media" };
  }
  if (text.length > 700 || caption.length > 700) {
    return { ok: false, error: "status_text_too_long" };
  }

  await ensureWhatsappRunning();
  const argv = ["--status"];
  if (text) argv.push("--text", text);
  if (mediaPath) argv.push("--media", mediaPath);
  if (caption) argv.push("--caption", caption);
  if (background) argv.push("--background", background);
  pushWhatsappWindowArg(argv, body);
  if (body.dryRun === true) argv.push("--dry-run");
  const result = await runPythonSidecar(whatsappSidecar, argv, 150_000);
  appendAudit("whatsapp_status", {
    ok: result.ok === true,
    host: typeof result.host === "string" ? result.host : null,
    dryRun: body.dryRun === true,
    verified: result.verified === true,
    hasMedia: Boolean(mediaPath),
    generatedFromText: result.generatedFromText === true,
    textLength: text.length,
    captionLength: caption.length,
    error: typeof result.error === "string" ? result.error : null,
  });
  return result;
}

async function handleCaptureAnalyze(body: JsonRecord): Promise<JsonRecord> {
  const outDir = resolve(runtimeDir, "screenshots");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `capture-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`);
  const argv = ["--out", outPath, "--max-elements", String(boundedInt(body.maxElements, 60, 5, 300))];
  pushWindowTargetArgs(argv, body);
  if (body.ocr === false) argv.push("--no-ocr");
  // 45s: the first call after a bridge restart pays Python/venv cold-start;
  // warm calls finish in ~5s. OCR adds a few seconds more.
  const result = await runPythonSidecar(captureSidecar, argv, 45_000);
  appendAudit("ui_capture", { path: outPath, ok: result.ok === true });
  return result;
}

// POST /play_media — resolve a song/query to an exact YouTube video and start
// it playing in the browser via the AMSI-safe Python path (no SendInput / no
// PowerShell). Pair with /now_playing to verify it actually plays.
async function handlePlayMedia(body: JsonRecord): Promise<JsonRecord> {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return { ok: false, error: "play_media_requires_query" };
  }
  const argv = ["--query", query];
  if (body.resolveOnly === true) argv.push("--no-open");
  const result = await runPythonSidecar(playMediaSidecar, argv, 20_000);
  appendAudit("play_media", { query, videoId: (result.videoId as JsonValue) ?? null, ok: result.ok === true });
  return result;
}

// POST /now_playing — Lumina's "ears": is audio ACTUALLY playing? Returns the
// default-device audio peak (real output level), which app is loudest, and the
// media session (SMTC) title/artist/status. This is how Lumina verifies "the
// music is playing" from observed reality instead of assuming a click worked.
async function handleNowPlaying(body: JsonRecord): Promise<JsonRecord> {
  const argv: string[] = [];
  argv.push("--settle-ms", String(boundedInt(body.settleMs, 700, 100, 5000)));
  const threshold = Number(body.threshold);
  if (Number.isFinite(threshold) && threshold > 0) argv.push("--threshold", String(threshold));
  const result = await runPythonSidecar(nowPlayingSidecar, argv, 12_000);
  appendAudit("now_playing", { playing: result.playing === true, audible: result.audible === true });
  return result;
}

// POST /vision_click — see-and-click by visible text for UIA-blind apps
// (Chromium/canvas/web). Screenshots + OCRs the screen, matches the requested
// text, and clicks its center via SendInput. action=find locates only.
async function handleVisionClick(body: JsonRecord): Promise<JsonRecord> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return { ok: false, error: "vision_click_requires_text" };
  }
  const action = body.action === "click" ? "click" : "find";
  const { text: _t, action: _a, ...params } = body;
  const argv = ["--action", action, "--text", text, "--json", JSON.stringify(params)];
  const result = await runPythonSidecar(visionClickSidecar, argv, 30_000);
  appendAudit("vision_click", { text, action, ok: result.ok === true });
  return result;
}

function isVisionStreamRunning(): boolean {
  return visionStreamProcess !== undefined && visionStreamProcess.exitCode === null;
}

function startVisionStreamSidecar(options: {
  fps?: number;
  restart?: boolean;
} = {}): JsonRecord {
  assertWindows();

  if (options.restart && isVisionStreamRunning()) {
    stopVisionStreamSidecar();
  }

  if (isVisionStreamRunning()) {
    return {
      ok: true,
      running: true,
      pid: visionStreamProcess?.pid ?? null,
      visionStreamStartedAt,
      visionStreamLastEventAt,
      visionStreamStatePath,
      visionStreamFramePath,
      message: "vision_stream_already_running",
    };
  }

  if (!existsSync(visionStreamSidecar)) {
    return {
      ok: false,
      running: false,
      error: "vision_stream_sidecar_missing",
      script: visionStreamSidecar,
    };
  }

  mkdirSync(dirname(visionStreamStatePath), { recursive: true });
  mkdirSync(dirname(visionStreamFramePath), { recursive: true });
  const rawFps = Number(options.fps ?? process.env.LUMINA_VISION_STREAM_FPS);
  const fps = Math.min(Math.max(Number.isFinite(rawFps) ? rawFps : 8, 1), 30);
  const argv = [
    "-X",
    "utf8",
    visionStreamSidecar,
    "--fps",
    String(fps),
    "--latest-state",
    visionStreamStatePath,
    "--latest-frame",
    visionStreamFramePath,
  ];

  const child = spawn(pythonExe, argv, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  visionStreamProcess = child;
  visionStreamStartedAt = Date.now();
  visionStreamLastEventAt = 0;
  visionStreamLastLine = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      visionStreamLastEventAt = Date.now();
      visionStreamLastLine = trimmed.slice(0, 2000);
      appendAudit("vision_stream_event", { line: visionStreamLastLine });
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const line = chunk.trim();
    if (line) {
      appendAudit("vision_stream_stderr", { line: line.slice(0, 2000) });
    }
  });

  child.on("exit", (code, signal) => {
    appendAudit("vision_stream_exit", { code: code ?? null, signal: signal ?? null });
    if (visionStreamProcess === child) {
      visionStreamProcess = undefined;
    }
  });

  appendAudit("vision_stream_start", {
    pid: child.pid ?? null,
    fps,
    latestState: visionStreamStatePath,
    latestFrame: visionStreamFramePath,
  });

  return {
    ok: true,
    running: true,
    pid: child.pid ?? null,
    visionStreamStartedAt,
    visionStreamStatePath,
    visionStreamFramePath,
    fps,
  };
}

function stopVisionStreamSidecar(): JsonRecord {
  const child = visionStreamProcess;
  if (!child || child.exitCode !== null) {
    visionStreamProcess = undefined;
    return {
      ok: true,
      running: false,
      message: "vision_stream_not_running",
      visionStreamStatePath,
      visionStreamFramePath,
    };
  }

  try {
    child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
  } catch {
    /* process may already be closing */
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  }, 1200).unref();

  appendAudit("vision_stream_stop", { pid: child.pid ?? null });
  return {
    ok: true,
    running: false,
    stopping: true,
    pid: child.pid ?? null,
    visionStreamStatePath,
    visionStreamFramePath,
  };
}

function handleVisionStreamControl(body: JsonRecord): JsonRecord {
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "status";

  if (action === "start") {
    return startVisionStreamSidecar({
      fps: typeof body.fps === "number" ? body.fps : undefined,
    });
  }

  if (action === "restart") {
    return startVisionStreamSidecar({
      fps: typeof body.fps === "number" ? body.fps : undefined,
      restart: true,
    });
  }

  if (action === "stop") {
    return stopVisionStreamSidecar();
  }

  if (action !== "status") {
    return {
      ok: false,
      error: "vision_stream_control_action_must_be_start_stop_restart_or_status",
      action,
    };
  }

  const stateFresh = isJsonStateFresh(visionStreamStatePath, 3_000);
  return {
    ok: true,
    running: isVisionStreamRunning(),
    pid: visionStreamProcess?.pid ?? null,
    visionStreamStartedAt,
    visionStreamLastEventAt,
    visionStreamLastLine,
    visionStreamStatePath,
    visionStreamFramePath,
    stateExists: existsSync(visionStreamStatePath),
    stateFresh,
    latestFrameExists: existsSync(visionStreamFramePath),
  };
}

async function handleVisionStream(): Promise<JsonRecord> {
  if (!isVisionStreamRunning()) {
    startVisionStreamSidecar();
  }

  if (!existsSync(visionStreamStatePath)) {
    return {
      ok: false,
      error: "vision_stream_starting",
      running: isVisionStreamRunning(),
      pid: visionStreamProcess?.pid ?? null,
      path: visionStreamStatePath,
      latestFramePath: visionStreamFramePath,
    };
  }

  try {
    const raw = readFileSync(visionStreamStatePath, "utf8");
    const parsed = JSON.parse(raw) as JsonRecord;
    const stateFresh = isParsedVisionStateFresh(parsed, 3_000);
    const running = isVisionStreamRunning();
    if (!running || !stateFresh) {
      return {
        ...parsed,
        ok: false,
        error: running ? "vision_stream_stale" : "vision_stream_not_running",
        stateFresh,
        visionStreamDaemon: {
          running,
          pid: visionStreamProcess?.pid ?? null,
          startedAt: visionStreamStartedAt,
          lastEventAt: visionStreamLastEventAt,
        },
      };
    }
    return {
      ...parsed,
      visionStreamDaemon: {
        running,
        pid: visionStreamProcess?.pid ?? null,
        startedAt: visionStreamStartedAt,
        lastEventAt: visionStreamLastEventAt,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isJsonStateFresh(path: string, maxAgeMs: number): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
    return isParsedVisionStateFresh(parsed, maxAgeMs);
  } catch {
    return false;
  }
}

function isParsedVisionStateFresh(parsed: JsonRecord, maxAgeMs: number): boolean {
  const candidates = [parsed.lastFrameAt, parsed.updatedAt];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs) {
      return true;
    }
  }

  return false;
}

function handleSchema(): JsonRecord {
  return {
    ok: true,
    service: "lumina-windows-bridge",
    endpoints: [
      {
        endpoint: "/health",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/system_context",
        method: "GET",
        body: {},
        description:
          "Read-only Windows context: clock, approximate location, Wi-Fi/network, battery, OS, storage, and privacy access state.",
        examples: [{}],
      },
      {
        endpoint: "/processes",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/camera_devices",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/logs",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/perception",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/vision_stream",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/perception_control",
        method: "POST",
        body: {
          action: "status | start | stop | restart",
          fps: "number optional (0.5 to 10)",
          threshold: "number optional (0.001 to 0.5)",
          saveFrames: "boolean optional",
        },
        examples: [
          { action: "status" },
          { action: "start", fps: 2 },
          { action: "restart", fps: 4, saveFrames: true },
        ],
      },
      {
        endpoint: "/vision_stream_control",
        method: "POST",
        body: {
          action: "status | start | stop | restart",
          fps: "number optional (1 to 30)",
        },
        examples: [
          { action: "status" },
          { action: "start", fps: 8 },
          { action: "restart", fps: 12 },
        ],
      },
      {
        endpoint: "/open_application",
        method: "POST",
        body: {
          target: "string",
          aliases: ["appName", "application", "app", "name", "url"],
          waitForWindow: "boolean optional",
          timeoutMs: "number optional",
        },
        examples: [
          { target: "YouTube", waitForWindow: true },
          { appName: "YouTube" },
          { url: "https://youtube.com" },
        ],
      },
      {
        endpoint: "/window_control",
        method: "POST",
        body: {
          action: "list | focus | launch | close | discover",
          launchAliases: ["application", "target", "appName", "app", "name"],
          discoverAliases: ["query", "filter", "target", "application", "appName", "name"],
        },
        examples: [
          { action: "discover", query: "YouTube" },
          { action: "launch", target: "YouTube", waitForWindow: true },
          { action: "focus", title: "YouTube" },
        ],
      },
      {
        endpoint: "/input_control",
        method: "POST",
        body: {
          action: "mouse_move | mouse_click | mouse_scroll | mouse_drag | type_text | key_press | shortcut",
          allowedApps: "string[] required",
        },
        examples: [
          { action: "shortcut", keys: ["CTRL", "L"], allowedApps: ["chrome", "msedge"] },
          { action: "type_text", text: "music", allowedApps: ["chrome", "msedge"] },
        ],
      },
      {
        endpoint: "/execute_powershell_safe",
        method: "POST",
        body: {
          command: "string",
          timeoutMs: "number optional",
        },
        examples: [{ command: "Get-Process | Select-Object -First 5 | ConvertTo-Json" }],
      },
      {
        endpoint: "/screenshot",
        method: "POST",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/clipboard",
        method: "POST",
        body: { action: "get | set", text: "string optional" },
        examples: [{ action: "get" }, { action: "set", text: "hello" }],
      },
      {
        endpoint: "/notify_toast",
        method: "POST",
        body: { title: "string", message: "string" },
        examples: [{ title: "Lumina", message: "Done" }],
      },
      {
        endpoint: "/phone_link/status",
        method: "GET",
        body: {},
        examples: [{}],
      },
      {
        endpoint: "/notifications",
        method: "POST",
        body: {
          application: "string optional app/source filter",
          limit: "number optional (1 to 200)",
          includeHidden: "boolean optional (default true)",
        },
        description:
          "Reads notifications currently retained in the Windows Notification Center through UI Automation.",
        examples: [{}, { application: "WhatsApp", limit: 20 }],
      },
      {
        endpoint: "/notifications/dismiss",
        method: "POST",
        body: {
          application: "string optional app/source filter",
          match: "string optional substring of the notification title/content",
          all: "boolean optional; with no app/match, clears every notification",
          maxDismiss: "number optional (1 to 200, default 25)",
        },
        description:
          "Dismisses (removes) notifications from the Windows Notification Center through UI Automation. Target a single app with application, a specific card with match, or clear everything with all=true.",
        examples: [
          { application: "WhatsApp" },
          { match: "codigo" },
          { all: true },
        ],
      },
      {
        endpoint: "/notifications/live",
        method: "POST",
        body: {},
        description:
          "Snapshot of current toast notifications via the WinRT UserNotificationListener. Opens no window and steals no focus, so it is safe to poll for live arrivals. Returns { notifications: [{ id, title, body, textElements, createdAt }] }.",
        examples: [{}],
      },
      {
        endpoint: "/phone_link/reply",
        method: "POST",
        body: {
          notificationId: "string",
          appUserModelId: "Microsoft.YourPhone package app id",
          mobileApp: "supported mobile messaging app",
          sender: "direct conversation sender",
          message: "exact notification message",
          textElements: "string[] from Windows notification listener",
          conversationKind: "direct",
          replyEligibility: "eligible",
          replyText: "string (max 280 characters)",
          dryRun: "boolean optional",
        },
        examples: [
          {
            notificationId: "phone-link-notification-id",
            appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
            mobileApp: "WhatsApp",
            sender: "Contact name",
            message: "Hello",
            textElements: ["WhatsApp", "Contact name", "Hello"],
            conversationKind: "direct",
            replyEligibility: "eligible",
            replyText: "Hello. I will get back to you shortly.",
            dryRun: true,
          },
        ],
      },
      {
        endpoint: "/ui_inspect",
        method: "POST",
        body: {
          pid: "number optional (defaults to foreground window)",
          hwnd: "number optional (target top-level window handle)",
          title: "string optional (target top-level window title substring)",
          processName: "string optional (target process name substring)",
          query: "string optional — fuzzy-resolve a target instead of full tree",
          controlType: "string optional (Button, Edit, Hyperlink, ...)",
          maxDepth: "number optional",
          maxNodes: "number optional",
          maxMatches: "number optional (query mode)",
        },
        examples: [{}, { title: "Reloj", query: "Nueva alarma", controlType: "Button" }],
      },
      {
        endpoint: "/ui_interact",
        method: "POST",
        body: {
          automationId: "string (preferred) — or name",
          name: "string — element name when no automationId",
          action: "invoke | click | set_value | toggle | select | focus",
          value: "string (for set_value)",
          controlType: "string optional",
          nameMatch: "contains | exact optional",
          fuzzyMatch: "boolean optional — resolve a partial/reordered name (e.g. 'Sandra' -> 'Sandra Patricia')",
          waitForElementMs: "number optional — poll up to N ms for the element before acting",
          thenPress: "enter | tab | escape optional — focus the element and send this key after acting (submits when Send is not in the UIA tree)",
          pid: "number optional",
          hwnd: "number optional (target top-level window handle)",
          title: "string optional (target top-level window title substring)",
          processName: "string optional (target process name substring)",
        },
        examples: [
          { title: "Reloj", name: "Nueva alarma", action: "invoke" },
          { title: "Reloj", automationId: "HourTextBox", action: "set_value", value: "07" },
          { processName: "whatsapp", name: "Sandra", fuzzyMatch: true, action: "click", waitForElementMs: 6000 },
          { name: "message", action: "set_value", value: "Aquí estoy", thenPress: "enter" },
        ],
      },
      {
        endpoint: "/whatsapp/contacts",
        method: "POST",
        body: {
          query: "string optional — search chats and contacts by name",
          limit: "number optional (1-200, default 40)",
          unreadOnly: "boolean optional — return only conversations with unread messages",
          includePreviews: "boolean optional (default true)",
          window: "whatsapp | whatsapp_web | phone_link optional",
        },
        examples: [{}, { query: "Sandra", includePreviews: false }],
      },
      {
        endpoint: "/whatsapp/messages",
        method: "POST",
        body: {
          contact: "string — contact/conversation name (safely fuzzy-matched)",
          limit: "number optional (1-100, default 40)",
          window: "whatsapp | whatsapp_web | phone_link optional",
          note: "Opening a conversation can mark its unread messages as read.",
        },
        examples: [{ contact: "Sandra Patricia", limit: 20 }],
      },
      {
        endpoint: "/whatsapp/reply",
        method: "POST",
        body: {
          contact: "string — contact/conversation name (safely fuzzy-matched)",
          message: "string optional — text or attachment caption (<= 4096 chars)",
          mediaPath: "string optional — local image, video, audio, or document",
          window: "whatsapp | whatsapp_web | phone_link optional",
          dryRun: "boolean optional — resolve and validate without sending",
        },
        examples: [
          { contact: "Sandra Patricia", message: "Aquí estoy" },
          {
            contact: "Sandra",
            mediaPath: "C:\\Users\\me\\Pictures\\photo.jpg",
            message: "Mira esta foto",
            dryRun: true,
          },
        ],
      },
      {
        endpoint: "/whatsapp/statuses",
        method: "POST",
        body: {
          limit: "number optional (1-200, default 40)",
          window: "whatsapp | whatsapp_web optional",
          note: "Lists authors/timestamps without viewing individual statuses.",
        },
        examples: [{ limit: 20 }],
      },
      {
        endpoint: "/whatsapp/status",
        method: "POST",
        body: {
          text: "string optional — rendered locally as a text status image",
          mediaPath: "string optional — local photo or video",
          caption: "string optional (<= 700 chars)",
          background: "hex color optional for rendered text (default #075E54)",
          window: "whatsapp | whatsapp_web optional",
          dryRun: "boolean optional — validate and prepare without publishing",
        },
        examples: [
          { text: "Disponible hoy", background: "#075E54", dryRun: true },
          {
            mediaPath: "C:\\Users\\me\\Pictures\\announcement.jpg",
            caption: "Nuevo anuncio",
            dryRun: true,
          },
        ],
      },
      {
        endpoint: "/ui_wait",
        method: "POST",
        body: {
          query: "string — or name / automationId",
          name: "string optional",
          automationId: "string optional",
          controlType: "string optional",
          timeoutMs: "number optional (default 8000)",
          intervalMs: "number optional (default 400)",
          pid: "number optional",
          hwnd: "number optional (target top-level window handle)",
          title: "string optional (target top-level window title substring)",
          processName: "string optional (target process name substring)",
        },
        examples: [{ title: "Reloj", query: "Guardar", timeoutMs: 10000 }],
      },
      {
        endpoint: "/ui_capture",
        method: "POST",
        body: {
          pid: "number optional (defaults to foreground)",
          hwnd: "number optional (target top-level window handle)",
          title: "string optional (target top-level window title substring; captures that window even when foreground is VS Code when Windows PrintWindow supports it)",
          processName: "string optional (target process name substring)",
          maxElements: "number optional",
          ocr: "boolean optional (set false to skip OCR)",
        },
        examples: [{}, { title: "Reloj", ocr: true }, { title: "Calculadora", ocr: true }],
      },
      {
        endpoint: "/play_media",
        method: "POST",
        body: {
          query: "string — song/video to play on YouTube",
          resolveOnly: "boolean optional (resolve videoId without opening)",
        },
        examples: [{ query: "coldplay viva la vida" }],
      },
      {
        endpoint: "/now_playing",
        method: "POST",
        body: {
          settleMs: "number optional (peak sampling window)",
          threshold: "number optional (audible peak threshold)",
        },
        examples: [{}],
      },
      {
        endpoint: "/vision_click",
        method: "POST",
        body: {
          text: "string — visible text to find/click (OCR)",
          action: "find | click (default find)",
          allowedApps: "string[] required for click",
          occurrence: "number optional (which match, default 0)",
        },
        examples: [
          { text: "Search", action: "find" },
          { text: "Subscribe", action: "click", allowedApps: ["msedge", "chrome"] },
        ],
      },
    ],
  };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    sendJson(res, 204, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "lumina-windows-bridge",
      mode: process.env.LUMINA_MODE ?? "development",
      platform: process.platform,
      uptimeMs: Date.now() - startedAt,
      repoRoot,
      runtimeDir,
      alarmsDir,
      endpoints: bridgeEndpoints,
    });
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/processes") {
      sendJson(res, 200, await handleProcesses());
      return;
    }
    if (req.method === "GET" && url.pathname === "/system_context") {
      sendJson(res, 200, await handleSystemContext());
      return;
    }
    if (req.method === "GET" && url.pathname === "/camera_devices") {
      sendJson(res, 200, await handleCameraDevices());
      return;
    }
    if (req.method === "GET" && url.pathname === "/logs") {
      sendJson(res, 200, await handleLogs());
      return;
    }
    if (req.method === "GET" && url.pathname === "/perception") {
      sendJson(res, 200, await handlePerception());
      return;
    }
    if (req.method === "GET" && url.pathname === "/vision_stream") {
      sendJson(res, 200, await handleVisionStream());
      return;
    }
    if (req.method === "GET" && url.pathname === "/phone_link/status") {
      sendJson(res, 200, await handlePhoneLinkStatus());
      return;
    }
    if (req.method === "GET" && url.pathname === "/schema") {
      sendJson(res, 200, handleSchema());
      return;
    }
    if (req.method !== "POST") {
      notFound(res);
      return;
    }
    const body = await readJson(req);
    if (url.pathname === "/perception_control") sendJson(res, 200, handlePerceptionControl(body));
    else if (url.pathname === "/vision_stream_control") sendJson(res, 200, handleVisionStreamControl(body));
    else if (url.pathname === "/open_application") sendJson(res, 200, await handleOpenApplication(body));
    else if (url.pathname === "/open_settings") sendJson(res, 200, await handleOpenSettings(body));
    else if (url.pathname === "/execute_powershell_safe") sendJson(res, 200, await handlePowerShellSafe(body));
    else if (url.pathname === "/clipboard") sendJson(res, 200, await handleClipboard(body));
    else if (url.pathname === "/notify_toast") sendJson(res, 200, await handleNotifyToast(body));
    else if (url.pathname === "/alarms") sendJson(res, 200, await handleAlarms(body));
    else if (url.pathname === "/window_control") sendJson(res, 200, await handleWindowControl(body));
    else if (url.pathname === "/screenshot") sendJson(res, 200, await handleScreenshot());
    else if (url.pathname === "/input") sendJson(res, 200, await handleInput(body));
    else if (url.pathname === "/input_control") sendJson(res, 200, await handleInputControl(body));
    else if (url.pathname === "/ui_inspect") sendJson(res, 200, await handleUiInspect(body));
    else if (url.pathname === "/ui_interact") sendJson(res, 200, await handleUiInteract(body));
    else if (url.pathname === "/ui_wait") sendJson(res, 200, await handleUiWait(body));
    else if (url.pathname === "/ui_capture") sendJson(res, 200, await handleCaptureAnalyze(body));
    else if (url.pathname === "/play_media") sendJson(res, 200, await handlePlayMedia(body));
    else if (url.pathname === "/now_playing") sendJson(res, 200, await handleNowPlaying(body));
    else if (url.pathname === "/vision_click") sendJson(res, 200, await handleVisionClick(body));
    else if (url.pathname === "/notifications") sendJson(res, 200, await handleNotifications(body));
    else if (url.pathname === "/notifications/dismiss") sendJson(res, 200, await handleNotificationsDismiss(body));
    else if (url.pathname === "/notifications/live") sendJson(res, 200, await handleNotificationsLive());
    else if (url.pathname === "/phone_link/reply") sendJson(res, 200, await handlePhoneLinkReply(body));
    else if (url.pathname === "/whatsapp/contacts") sendJson(res, 200, await handleWhatsappContacts(body));
    else if (url.pathname === "/whatsapp/messages") sendJson(res, 200, await handleWhatsappMessages(body));
    else if (url.pathname === "/whatsapp/reply") sendJson(res, 200, await handleWhatsappReply(body));
    else if (url.pathname === "/whatsapp/statuses") sendJson(res, 200, await handleWhatsappStatuses(body));
    else if (url.pathname === "/whatsapp/status") sendJson(res, 200, await handleWhatsappStatus(body));
    else if (url.pathname === "/voice/claude-response") sendJson(res, 200, handleVoiceClaudeEnqueue(body));
    else if (url.pathname === "/voice/claude-response/pending") sendJson(res, 200, handleVoiceClaudePending());
    else notFound(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAudit("error", { path: url.pathname, message });
    sendJson(res, 500, { ok: false, error: message });
  }
}

const server = createServer((req, res) => {
  if (req.socket.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: "localhost_only" });
    return;
  }
  void route(req, res);
});

server.listen(port, "127.0.0.1", () => {
  appendAudit("start", { port, repoRoot });
  console.log(`[lumina-windows-bridge] listening on http://127.0.0.1:${port}`);
  void refreshSystemContext().catch((error) => {
    appendAudit("system_context_prewarm_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  if (process.env.LUMINA_PERCEPTION_AUTOSTART !== "false") {
    const result = startPerceptionSidecar();
    console.log(
      `[lumina-windows-bridge] perception ${result.ok ? "started" : "not started"} ${JSON.stringify(result)}`,
    );
  }
  if (process.env.LUMINA_VISION_STREAM_AUTOSTART !== "false") {
    const result = startVisionStreamSidecar();
    console.log(
      `[lumina-windows-bridge] vision stream ${result.ok ? "started" : "not started"} ${JSON.stringify(result)}`,
    );
  }
});

process.on("SIGINT", () => {
  stopVisionStreamSidecar();
  stopPerceptionSidecar();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  stopVisionStreamSidecar();
  stopPerceptionSidecar();
  server.close(() => process.exit(0));
});

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

const LIST_WINDOWS_PS = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lp2);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<object[]> GetAll() {
    var list = new List<object[]>();
    EnumWindows((h,_) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        var t = sb.ToString().Trim();
        if (t.Length > 0) {
          uint pid = 0; GetWindowThreadProcessId(h, out pid);
          list.Add(new object[]{ h.ToInt64(), t, pid });
        }
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$wins = [WinList]::GetAll()
$result = $wins | ForEach-Object {
  $proc = Get-Process -Id $_[2] -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    handle = $_[0]
    title  = $_[1]
    pid    = $_[2]
    process = if($proc){ $proc.ProcessName } else { "unknown" }
  }
}
$result | ConvertTo-Json -Compress
`.trim();

function FOCUS_WINDOW_PS(title: string): string {
  return `
$target = ${JSON.stringify(title)}
$activated = $false
try {
  $shell = New-Object -ComObject WScript.Shell
  $activated = [bool]$shell.AppActivate($target)
} catch {}
if ($activated) {
  Start-Sleep -Milliseconds 350
  [PSCustomObject]@{ found=$true; focused=$true; foregroundProcess=""; via="appactivate" } | ConvertTo-Json -Compress
  exit 0
}
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lp2);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static string ForegroundProcess() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }
  public static bool ForceForeground(IntPtr h) {
    IntPtr foreground = GetForegroundWindow();
    uint targetPid;
    uint foregroundPid;
    uint targetThread = GetWindowThreadProcessId(h, out targetPid);
    uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
    uint currentThread = GetCurrentThreadId();
    bool attachedForeground = false;
    bool attachedTarget = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) {
        attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      }
      if (targetThread != 0 && targetThread != currentThread) {
        attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      }
      ShowWindow(h, 9);
      BringWindowToTop(h);
      return SetForegroundWindow(h);
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
"@
$found = $false
$focused = $false
[WinFocus]::EnumWindows({
  param($h, $lp)
  if ([WinFocus]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinFocus]::GetWindowText($h, $sb, 256) | Out-Null
    if ($sb.ToString() -like "*$target*") {
      $script:focused = [WinFocus]::ForceForeground($h)
      $script:found = $true
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($found) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate($target) | Out-Null
  } catch {}
}
Start-Sleep -Milliseconds 350
[PSCustomObject]@{ found=$found; focused=$focused; foregroundProcess=[WinFocus]::ForegroundProcess() } | ConvertTo-Json -Compress
`.trim();
}

// Curated alias map for the most common apps Dal asks for by name.
// Anything NOT here falls through to Get-StartApps fuzzy match in handleLaunch.
const APPLICATIONS: Record<string, { target: string; displayName: string }> = {
  // Browsers
  browser: { target: "microsoft-edge:", displayName: "Microsoft Edge" },
  edge: { target: "microsoft-edge:", displayName: "Microsoft Edge" },
  chrome: { target: "chrome.exe", displayName: "Google Chrome" },
  firefox: { target: "firefox.exe", displayName: "Mozilla Firefox" },
  brave: { target: "brave.exe", displayName: "Brave" },
  opera: { target: "opera.exe", displayName: "Opera" },
  vivaldi: { target: "vivaldi.exe", displayName: "Vivaldi" },
  arc: { target: "arc.exe", displayName: "Arc" },
  // Web shortcuts (open in default browser via protocol)
  youtube: { target: "microsoft-edge:https://www.youtube.com", displayName: "YouTube" },
  google: { target: "microsoft-edge:https://www.google.com", displayName: "Google Search" },
  gmail: { target: "microsoft-edge:https://mail.google.com", displayName: "Gmail" },
  drive: { target: "microsoft-edge:https://drive.google.com", displayName: "Google Drive" },
  github: { target: "microsoft-edge:https://github.com", displayName: "GitHub" },
  // Microsoft Office (Click-to-Run shorts; resolved via App Paths registry)
  word: { target: "winword", displayName: "Microsoft Word" },
  excel: { target: "excel", displayName: "Microsoft Excel" },
  powerpoint: { target: "powerpnt", displayName: "Microsoft PowerPoint" },
  outlook: { target: "outlook", displayName: "Microsoft Outlook" },
  onenote: { target: "onenote", displayName: "Microsoft OneNote" },
  access: { target: "msaccess", displayName: "Microsoft Access" },
  publisher: { target: "mspub", displayName: "Microsoft Publisher" },
  visio: { target: "visio", displayName: "Microsoft Visio" },
  project: { target: "winproj", displayName: "Microsoft Project" },
  teams: { target: "ms-teams:", displayName: "Microsoft Teams" },
  onedrive: { target: "onedrive.exe", displayName: "Microsoft OneDrive" },
  // Productivity / messaging
  slack: { target: "slack.exe", displayName: "Slack" },
  discord: { target: "discord.exe", displayName: "Discord" },
  telegram: { target: "telegram.exe", displayName: "Telegram" },
  whatsapp: { target: "whatsapp:", displayName: "WhatsApp" },
  signal: { target: "signal.exe", displayName: "Signal" },
  zoom: { target: "zoom.exe", displayName: "Zoom" },
  notion: { target: "notion.exe", displayName: "Notion" },
  obsidian: { target: "obsidian.exe", displayName: "Obsidian" },
  // Media
  spotify: { target: "spotify:", displayName: "Spotify" },
  vlc: { target: "vlc.exe", displayName: "VLC" },
  obs: { target: "obs64.exe", displayName: "OBS Studio" },
  // Dev tools
  vscode: { target: "code.cmd", displayName: "Visual Studio Code" },
  cursor: { target: "cursor.exe", displayName: "Cursor" },
  sublime: { target: "subl.exe", displayName: "Sublime Text" },
  notepadpp: { target: "notepad++.exe", displayName: "Notepad++" },
  postman: { target: "postman.exe", displayName: "Postman" },
  docker: { target: "Docker Desktop.exe", displayName: "Docker Desktop" },
  // Creative
  gimp: { target: "gimp.exe", displayName: "GIMP" },
  blender: { target: "blender.exe", displayName: "Blender" },
  inkscape: { target: "inkscape.exe", displayName: "Inkscape" },
  figma: { target: "figma.exe", displayName: "Figma" },
  // Gaming
  steam: { target: "steam.exe", displayName: "Steam" },
  epic: { target: "EpicGamesLauncher.exe", displayName: "Epic Games" },
  // System (Windows built-ins)
  notepad: { target: "notepad.exe", displayName: "Notepad" },
  calculator: { target: "calc.exe", displayName: "Calculator" },
  calc: { target: "calc.exe", displayName: "Calculator" },
  explorer: { target: "explorer.exe", displayName: "File Explorer" },
  files: { target: "explorer.exe", displayName: "File Explorer" },
  settings: { target: "ms-settings:", displayName: "Windows Settings" },
  store: { target: "ms-windows-store:", displayName: "Microsoft Store" },
  photos: { target: "ms-photos:", displayName: "Microsoft Photos" },
  camera: { target: "microsoft.windows.camera:", displayName: "Camera" },
  mail: { target: "outlookmail:", displayName: "Mail (Windows)" },
  calendar: { target: "outlookcal:", displayName: "Calendar (Windows)" },
  maps: { target: "bingmaps:", displayName: "Maps" },
  weather: { target: "bingweather:", displayName: "Weather" },
  paint: { target: "mspaint.exe", displayName: "Paint" },
  snipping: { target: "ms-screensketch:", displayName: "Snipping Tool" },
  taskmanager: { target: "taskmgr.exe", displayName: "Task Manager" },
  controlpanel: { target: "control.exe", displayName: "Control Panel" },
  regedit: { target: "regedit.exe", displayName: "Registry Editor" },
  services: { target: "services.msc", displayName: "Services" },
  // Terminals / shells
  terminal: { target: "wt.exe", displayName: "Windows Terminal" },
  powershell: { target: "powershell.exe", displayName: "Windows PowerShell" },
  pwsh: { target: "pwsh.exe", displayName: "PowerShell 7" },
  cmd: { target: "cmd.exe", displayName: "Command Prompt" },
  wsl: { target: "wsl.exe", displayName: "WSL" },
};
