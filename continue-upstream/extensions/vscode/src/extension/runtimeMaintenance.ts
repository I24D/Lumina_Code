import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

import { getContinueGlobalPath } from "core/util/paths";
import * as vscode from "vscode";

import { getLuminaRuntimeStatus } from "./backendLifecycle";
import { resolveStartTalkOrbExecutable } from "./startTalkOrb";

import type {
  LuminaBackupResult,
  LuminaDoctorCheck,
  LuminaDoctorReport,
  LuminaUpdateStatus,
} from "core/protocol/ideWebview";

const BACKUP_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SENSITIVE_KEY =
  /(?:api[_-]?key|token|secret|password|authorization|cookie|credential|private[_-]?key)/iu;
const VOLATILE_GLOBAL_KEY = /(?:\.pid$|pendingWorktreeSessions$)/u;
const RESTORABLE_GLOBAL_KEYS = new Set([
  "hasBeenInstalled",
  "lumina.startTalk.geminiOptions",
  "quickEditHistory",
]);

const PERSISTENT_FILES = [
  { id: "workboard", relativeTo: "continue", file: "lumina-workboard.json" },
  {
    id: "scheduled-tasks",
    relativeTo: "continue",
    file: "lumina-scheduled-tasks.json",
  },
  { id: "channels", relativeTo: "continue", file: "lumina-channels.json" },
  {
    id: "permissions",
    relativeTo: "continue",
    file: "lumina-permissions.json",
  },
  { id: "memory", relativeTo: "agent", file: "memory.json" },
  { id: "agent-tasks", relativeTo: "agent", file: "tasks.json" },
  {
    id: "experiences",
    relativeTo: "agent",
    file: "experiences.jsonl",
  },
] as const;

type PersistentFileId = (typeof PERSISTENT_FILES)[number]["id"];

type BackupFile = { id: PersistentFileId; content: string };
type WorkspaceBackupFile = {
  workspaceIndex: number;
  workspaceName: string;
  relativePath: string;
  content: string;
};

export type LuminaBackupDocument = {
  schema: "lumina-code-backup";
  version: 1;
  createdAt: string;
  extensionVersion: string;
  secretsExcluded: true;
  auditExcluded: true;
  globalState: Record<string, unknown>;
  persistentFiles: BackupFile[];
  workspaceFiles: WorkspaceBackupFile[];
};

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/giu, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;"']+/giu,
      "$1[REDACTED]",
    );
}

/** Recursively removes secret-shaped fields before backup data leaves storage. */
export function sanitizeBackupValue(value: unknown, depth = 0): unknown {
  if (depth > 12) {
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    return redactString(value).slice(0, MAX_FILE_BYTES);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 10_000)
      .map((entry) => sanitizeBackupValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .slice(0, 10_000)
        .map(([key, entry]) => [key, sanitizeBackupValue(entry, depth + 1)]),
    );
  }
  return undefined;
}

function persistentFilePath(
  definition: (typeof PERSISTENT_FILES)[number],
): string {
  const root =
    definition.relativeTo === "continue"
      ? getContinueGlobalPath()
      : path.join(os.homedir(), ".lumina-code", "agent-state");
  return path.join(root, definition.file);
}

function readSanitizedFile(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const text = fs.readFileSync(filePath, "utf8");
    try {
      return JSON.stringify(sanitizeBackupValue(JSON.parse(text)), null, 2);
    } catch {
      return redactString(text).slice(0, MAX_FILE_BYTES);
    }
  } catch {
    return undefined;
  }
}

function isAllowedWorkspaceRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/");
  return (
    /^\.continue\/(?:rules|skills|plugins)\/.+/u.test(normalized) &&
    /\.(?:md|json|ya?ml)$/iu.test(normalized) &&
    !normalized.split("/").includes("..")
  );
}

function collectWorkspaceFiles(): WorkspaceBackupFile[] {
  const collected: WorkspaceBackupFile[] = [];
  let totalBytes = 0;
  for (const [workspaceIndex, folder] of (
    vscode.workspace.workspaceFolders ?? []
  ).entries()) {
    const continueRoot = path.join(folder.uri.fsPath, ".continue");
    for (const section of ["rules", "skills", "plugins"]) {
      const root = path.join(continueRoot, section);
      if (!fs.existsSync(root)) {
        continue;
      }
      const pending = [root];
      while (pending.length && totalBytes < MAX_TOTAL_BYTES) {
        const current = pending.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const absolute = path.join(current, entry.name);
          if (entry.isSymbolicLink()) {
            continue;
          }
          if (entry.isDirectory()) {
            pending.push(absolute);
            continue;
          }
          const relativePath = path
            .relative(folder.uri.fsPath, absolute)
            .replace(/\\/gu, "/");
          if (!isAllowedWorkspaceRelativePath(relativePath)) {
            continue;
          }
          const content = readSanitizedFile(absolute);
          if (content === undefined) {
            continue;
          }
          const bytes = Buffer.byteLength(content);
          if (totalBytes + bytes > MAX_TOTAL_BYTES) {
            break;
          }
          totalBytes += bytes;
          collected.push({
            workspaceIndex,
            workspaceName: folder.name,
            relativePath,
            content,
          });
        }
      }
    }
  }
  return collected;
}

export function validateBackupDocument(value: unknown): LuminaBackupDocument {
  if (!value || typeof value !== "object") {
    throw new Error("Backup inválido.");
  }
  const candidate = value as Partial<LuminaBackupDocument>;
  if (
    candidate.schema !== "lumina-code-backup" ||
    candidate.version !== BACKUP_SCHEMA_VERSION ||
    !candidate.globalState ||
    Array.isArray(candidate.globalState) ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.extensionVersion !== "string" ||
    candidate.secretsExcluded !== true ||
    candidate.auditExcluded !== true ||
    !Array.isArray(candidate.persistentFiles) ||
    !Array.isArray(candidate.workspaceFiles)
  ) {
    throw new Error("El archivo no es un backup compatible de Lumina Code.");
  }
  if (
    Object.keys(candidate.globalState).some(
      (key) => !RESTORABLE_GLOBAL_KEYS.has(key) || SENSITIVE_KEY.test(key),
    ) ||
    candidate.persistentFiles.some(
      (entry) =>
        !entry ||
        !PERSISTENT_FILES.some((allowed) => allowed.id === entry.id) ||
        typeof entry.content !== "string" ||
        Buffer.byteLength(entry.content) > MAX_FILE_BYTES,
    ) ||
    candidate.workspaceFiles.some(
      (entry) =>
        !entry ||
        !Number.isInteger(entry.workspaceIndex) ||
        entry.workspaceIndex < 0 ||
        typeof entry.relativePath !== "string" ||
        !isAllowedWorkspaceRelativePath(entry.relativePath) ||
        typeof entry.content !== "string" ||
        Buffer.byteLength(entry.content) > MAX_FILE_BYTES,
    )
  ) {
    throw new Error("El backup contiene rutas o entradas no permitidas.");
  }
  const contentBytes = [
    ...candidate.persistentFiles,
    ...candidate.workspaceFiles,
  ].reduce((total, entry) => total + Buffer.byteLength(entry.content), 0);
  if (contentBytes > MAX_TOTAL_BYTES) {
    throw new Error("El contenido del backup supera el límite permitido.");
  }
  return candidate as LuminaBackupDocument;
}

export async function createLuminaBackup(
  context: vscode.ExtensionContext,
): Promise<LuminaBackupResult> {
  const date = new Date().toISOString().slice(0, 10);
  const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = firstWorkspace
    ? vscode.Uri.joinPath(firstWorkspace, `Lumina-Code-backup-${date}.json`)
    : vscode.Uri.file(
        path.join(os.homedir(), `Lumina-Code-backup-${date}.json`),
      );
  const destination = await vscode.window.showSaveDialog({
    title: "Guardar backup seguro de Lumina Code",
    defaultUri,
    filters: { "Lumina Code backup": ["json"] },
  });
  if (!destination) {
    return { canceled: true };
  }

  const globalState = Object.fromEntries(
    context.globalState
      .keys()
      .filter(
        (key) =>
          RESTORABLE_GLOBAL_KEYS.has(key) &&
          !SENSITIVE_KEY.test(key) &&
          !VOLATILE_GLOBAL_KEY.test(key),
      )
      .map((key) => [
        key,
        sanitizeBackupValue(context.globalState.get<unknown>(key)),
      ]),
  );
  const persistentFiles = PERSISTENT_FILES.flatMap((definition) => {
    const content = readSanitizedFile(persistentFilePath(definition));
    return content === undefined ? [] : [{ id: definition.id, content }];
  });
  const workspaceFiles = collectWorkspaceFiles();
  const document: LuminaBackupDocument = {
    schema: "lumina-code-backup",
    version: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    extensionVersion: String(
      context.extension.packageJSON.version ?? "unknown",
    ),
    secretsExcluded: true,
    auditExcluded: true,
    globalState,
    persistentFiles,
    workspaceFiles,
  };
  await fs.promises.writeFile(
    destination.fsPath,
    JSON.stringify(document, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    canceled: false,
    path: destination.fsPath,
    globalEntries: Object.keys(globalState).length + persistentFiles.length,
    workspaceFiles: workspaceFiles.length,
  };
}

export async function restoreLuminaBackup(
  context: vscode.ExtensionContext,
): Promise<LuminaBackupResult> {
  const picked = await vscode.window.showOpenDialog({
    title: "Restaurar backup de Lumina Code",
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    filters: { "Lumina Code backup": ["json"] },
  });
  if (!picked?.[0]) {
    return { canceled: true };
  }
  const stat = await fs.promises.stat(picked[0].fsPath);
  if (stat.size > MAX_TOTAL_BYTES * 2) {
    throw new Error("El backup es demasiado grande.");
  }
  const document = validateBackupDocument(
    JSON.parse(await fs.promises.readFile(picked[0].fsPath, "utf8")),
  );
  const confirmation = await vscode.window.showWarningMessage(
    "Restaurar sobrescribirá el estado local incluido y las reglas, skills o plugins coincidentes. Los secretos nunca se restauran. VS Code se recargará al terminar.",
    { modal: true },
    "Restaurar y recargar",
  );
  if (confirmation !== "Restaurar y recargar") {
    return { canceled: true };
  }

  for (const [key, value] of Object.entries(document.globalState)) {
    if (
      !RESTORABLE_GLOBAL_KEYS.has(key) ||
      SENSITIVE_KEY.test(key) ||
      VOLATILE_GLOBAL_KEY.test(key)
    ) {
      continue;
    }
    await context.globalState.update(key, sanitizeBackupValue(value));
  }
  for (const entry of document.persistentFiles) {
    const definition = PERSISTENT_FILES.find((item) => item.id === entry.id)!;
    const target = persistentFilePath(definition);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, entry.content, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  const workspaces = vscode.workspace.workspaceFolders ?? [];
  for (const entry of document.workspaceFiles) {
    const folder = workspaces[entry.workspaceIndex];
    if (!folder) {
      continue;
    }
    const root = path.resolve(folder.uri.fsPath);
    const target = path.resolve(root, entry.relativePath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, entry.content, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  void vscode.commands.executeCommand("workbench.action.reloadWindow");
  return {
    canceled: false,
    path: picked[0].fsPath,
    globalEntries:
      Object.keys(document.globalState).length +
      document.persistentFiles.length,
    workspaceFiles: document.workspaceFiles.length,
    restored: true,
  };
}

function fileCheck(
  id: string,
  label: string,
  candidates: string[],
  remediation: string,
  minimumBytes = 1,
): LuminaDoctorCheck {
  const found = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).size >= minimumBytes;
    } catch {
      return false;
    }
  });
  return found
    ? { id, label, status: "pass", detail: "Disponible y legible." }
    : {
        id,
        label,
        status: "fail",
        detail: "No se encontró el recurso requerido o está vacío.",
        remediation,
      };
}

export async function runLuminaDoctor(
  context: vscode.ExtensionContext,
): Promise<LuminaDoctorReport> {
  const runtime = await getLuminaRuntimeStatus(context);
  const extensionRoot = context.extensionPath;
  const checks: LuminaDoctorCheck[] = [
    {
      id: "platform",
      label: "Plataforma",
      status: process.platform === "win32" ? "pass" : "warning",
      detail: `${process.platform} ${process.arch} · Node ${process.versions.node}`,
      ...(process.platform === "win32"
        ? {}
        : {
            remediation:
              "La distribución estable se valida actualmente en Windows x64.",
          }),
    },
    fileCheck(
      "gui",
      "Bundle de la interfaz",
      [
        path.join(extensionRoot, "gui", "index.html"),
        path.resolve(extensionRoot, "../../gui/dist/index.html"),
      ],
      "Ejecuta npm run build en continue-upstream/gui o el flujo oficial de instalación.",
      100,
    ),
    fileCheck(
      "sqlite",
      "Binding nativo SQLite",
      [
        path.join(extensionRoot, "out/build/Release/node_sqlite3.node"),
        path.join(extensionRoot, "out/Release/node_sqlite3.node"),
      ],
      "Ejecuta scripts/copy-sqlite-binding.js o ABRIR_LUMINA_CODE_DEV.ps1.",
      50_000,
    ),
    fileCheck(
      "lancedb",
      "Binding nativo LanceDB",
      [
        path.join(
          extensionRoot,
          "out/node_modules/@lancedb/vectordb-win32-x64-msvc/index.node",
        ),
        path.join(
          extensionRoot,
          "node_modules/@lancedb/vectordb-win32-x64-msvc/index.node",
        ),
      ],
      "Ejecuta la reparación de LanceDB incluida en ABRIR_LUMINA_CODE_DEV.ps1.",
      50_000,
    ),
  ];

  const orb = resolveStartTalkOrbExecutable(context);
  checks.push(
    orb
      ? {
          id: "start-talk",
          label: "Ejecutable Start Talk",
          status: "pass",
          detail: "Orbe nativo disponible.",
        }
      : {
          id: "start-talk",
          label: "Ejecutable Start Talk",
          status: "warning",
          detail: "El chat funciona, pero el orbe nativo no está compilado.",
          remediation:
            "Compila Start-talk con npm run tauri build -- --no-bundle.",
        },
  );

  const hasGeminiSecret = Boolean(
    (await context.secrets.get("lumina.startTalk.geminiApiKey")) ||
      process.env.GEMINI_API_KEY,
  );
  checks.push({
    id: "gemini",
    label: "Configuración de voz",
    status: hasGeminiSecret ? "pass" : "warning",
    detail: hasGeminiSecret
      ? "Credencial de Gemini detectada sin leer ni mostrar su valor."
      : "No se detectó una credencial global; un .env del workspace aún puede proveerla.",
    ...(hasGeminiSecret
      ? {}
      : {
          remediation:
            "Configura Start Talk desde Ajustes o GEMINI_API_KEY en un .env privado.",
        }),
  });

  for (const component of runtime.components) {
    checks.push({
      id: `worker-${component.name}`,
      label: component.label,
      status:
        component.status === "connected"
          ? "pass"
          : component.required
            ? "fail"
            : "warning",
      detail:
        component.status === "connected"
          ? "Worker respondió al sondeo local."
          : component.required
            ? "Worker requerido sin respuesta."
            : "Worker opcional sin respuesta.",
      ...(component.status === "connected"
        ? {}
        : {
            remediation:
              "Revisa los registros o reinicia el runtime administrado.",
          }),
    });
  }

  try {
    await fs.promises.mkdir(context.globalStorageUri.fsPath, {
      recursive: true,
    });
    await fs.promises.access(
      context.globalStorageUri.fsPath,
      fs.constants.W_OK,
    );
    checks.push({
      id: "storage",
      label: "Almacenamiento local",
      status: "pass",
      detail: "El directorio de estado es escribible.",
    });
  } catch {
    checks.push({
      id: "storage",
      label: "Almacenamiento local",
      status: "fail",
      detail: "No se puede escribir el estado de la extensión.",
      remediation: "Comprueba permisos y espacio libre del perfil de VS Code.",
    });
  }

  const counts = {
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: checks.filter((check) => check.status === "warning").length,
    failed: checks.filter((check) => check.status === "fail").length,
  };
  return {
    state: counts.failed ? "failed" : counts.warnings ? "warning" : "healthy",
    checks,
    counts,
    checkedAt: new Date().toISOString(),
  };
}

export function compareVersions(current: string, latest: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/iu, "")
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(current);
  const right = parse(latest);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) {
      return (left[index] ?? 0) > (right[index] ?? 0) ? 1 : -1;
    }
  }
  return 0;
}

function requestLatestRelease(): Promise<{
  statusCode: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      "https://api.github.com/repos/I24D/Lumina_Code/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Lumina-Code-Update-Check",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout: 6_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length <= 1024 * 1024) {
            body += chunk;
          }
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 0, body }),
        );
      },
    );
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", reject);
  });
}

export async function checkLuminaUpdate(
  context: vscode.ExtensionContext,
): Promise<LuminaUpdateStatus> {
  const currentVersion = String(
    context.extension.packageJSON.version ?? "0.0.0",
  );
  const checkedAt = new Date().toISOString();
  try {
    const response = await requestLatestRelease();
    if (response.statusCode === 404) {
      return {
        status: "unpublished",
        currentVersion,
        checkedAt,
        message:
          "El repositorio aún no publica releases instalables; usa el flujo de código fuente documentado.",
      };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`GitHub respondió HTTP ${response.statusCode}`);
    }
    const release = JSON.parse(response.body) as {
      tag_name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
    };
    if (typeof release.tag_name !== "string") {
      throw new Error("release inválido");
    }
    const latestVersion = release.tag_name.replace(/^v/iu, "");
    const available = compareVersions(currentVersion, latestVersion) < 0;
    const releaseUrl =
      typeof release.html_url === "string" &&
      /^https:\/\/github\.com\/I24D\/Lumina_Code\/releases\//iu.test(
        release.html_url,
      )
        ? release.html_url
        : undefined;
    return {
      status: available ? "available" : "current",
      currentVersion,
      latestVersion,
      releaseUrl,
      publishedAt:
        typeof release.published_at === "string"
          ? release.published_at
          : undefined,
      checkedAt,
      message: available
        ? `Hay una versión ${latestVersion} disponible para revisión manual.`
        : "La extensión coincide con la última release publicada.",
    };
  } catch (error) {
    return {
      status: "error",
      currentVersion,
      checkedAt,
      message: `No se pudo comprobar GitHub: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
