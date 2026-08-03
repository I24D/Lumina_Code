/**
 * skill-loader.ts — Lumina implementation of the agentskills.io standard.
 *
 * Loads skills from a directory tree following the Anthropic Agent Skills
 * format (https://agentskills.io/specification). Each skill is a folder
 * whose name must match the `name:` field of its `SKILL.md` YAML
 * frontmatter. The body of `SKILL.md` is freeform Markdown — the
 * agent's instructions.
 *
 * Progressive disclosure (3 tiers):
 *   1. Discovery — only `name` + `description` exposed via list()
 *   2. Activation — full body Markdown loaded via get(id).instructions
 *   3. Resources — scripts/, references/, assets/ are listed by path only
 *      until something calls readAsset() to fetch a specific file
 *
 * Frontmatter spec (from https://agentskills.io/specification):
 *
 *   name           required  1-64 chars, [a-z0-9-], no leading/trailing -, no --
 *                            MUST match the parent folder name
 *   description    required  1-1024 chars, non-empty
 *   license        optional  free text
 *   compatibility  optional  1-500 chars
 *   metadata       optional  arbitrary key-value map (commonly: author, version)
 *   allowed-tools  optional  space-separated tool names (experimental)
 *
 * Lumina-specific behaviour:
 *   - Skills with invalid frontmatter are skipped, NOT crashing the loader.
 *     The error is captured in errors() so it can be surfaced via a tool.
 *   - The loader hot-reloads every `reloadEveryMs` (default 5s) so the
 *     user can drop a new SKILL.md and use it without restarting the
 *     gateway.
 *   - readAsset() refuses any path that escapes the skill directory
 *     (..-relative, absolute paths, symlinks pointing out) to prevent
 *     a malicious skill from reading c:/Windows/System32/...
 */
import fs from "node:fs";
import path from "node:path";

export type SkillMetadata = {
  /** Folder name and frontmatter `name`. Kebab-case. */
  readonly id: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  /** Tools the skill is pre-approved to use (spec experimental).
   *  Space-separated in the source; parsed into an array here. */
  readonly allowedTools: ReadonlyArray<string>;
  /** Arbitrary user metadata (author, version, tags, nested objects, …).
   *  Top-level fields not defined by the spec also land here. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Absolute path to the skill folder. */
  readonly skillDir: string;
  /** Absolute path to SKILL.md. */
  readonly skillFile: string;
  /** Semantic version (SemVer 2.0.0). Default: "1.0.0" if not specified. */
  readonly version: string;
  /** Whether the skill is deprecated. */
  readonly deprecated: boolean;
  /** Message shown when skill is deprecated. */
  readonly deprecationMessage?: string;
  /** Skill ID that replaces this one (if deprecated). */
  readonly replacedBy?: string;
};

export type SkillResource = {
  /** Path relative to the skill root (e.g. "scripts/extract.py"). */
  readonly relPath: string;
  /** Absolute path. */
  readonly absPath: string;
  /** Bytes — useful so the agent can refuse loading huge files. */
  readonly sizeBytes: number;
};

export type Skill = SkillMetadata & {
  /** Markdown body after the frontmatter — the agent's instructions. */
  readonly instructions: string;
  /** Files under scripts/, listed by path. NOT loaded. */
  readonly scripts: ReadonlyArray<SkillResource>;
  /** Files under references/, listed by path. NOT loaded. */
  readonly references: ReadonlyArray<SkillResource>;
  /** Files under assets/, listed by path. NOT loaded. */
  readonly assets: ReadonlyArray<SkillResource>;
};

export type SkillLoadError = {
  readonly folder: string;
  readonly skillFile: string;
  readonly error: string;
};

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — refuse to load runaway SKILL.md
const MAX_ASSET_LIST = 200;

type ParsedFrontmatter = {
  data: Record<string, unknown>;
  body: string;
};

/**
 * Tolerant YAML frontmatter parser for agentskills.io. Supports:
 *   - scalar strings (`key: value`)
 *   - block-style nested maps (`key:` then indented `subkey: value` lines)
 *   - flow-style values (`key: { "a": "b", "c": { "d": "e" } }`) — the
 *     value is parsed with JSON5-ish tolerance for trailing commas and
 *     unquoted keys, then handed to JSON.parse after light normalization.
 *
 * Design choices:
 *   - Required fields (name, description) validated strictly downstream.
 *   - Unknown top-level fields are kept under .data (so they can land
 *     in metadata as a passthrough) instead of rejecting the skill.
 *     Real-world skills ship homepage, vendor-specific keys, etc.
 *   - On any parse problem, return a structured error; caller logs it
 *     and skips the skill but doesn't crash.
 */
function parseFrontmatter(raw: string): ParsedFrontmatter | { error: string } {
  if (!raw.startsWith("---")) {
    return { error: "missing opening --- on first line" };
  }
  const lines = raw.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { error: "missing closing --- delimiter" };

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n").replace(/^\s+/u, "");

  const data: Record<string, unknown> = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("\t")) {
      // Stray indented line at top level — skip rather than fail (some
      // editors auto-indent and we'd rather be permissive).
      i++;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      // Treat as a comment / stray line; skip.
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();

    if (!key) {
      i++;
      continue;
    }

    if (valueRaw === "") {
      // Look ahead at the indented block.
      let j = i + 1;
      while (j < fmLines.length && (fmLines[j]!.startsWith(" ") || fmLines[j]!.startsWith("\t"))) {
        j++;
      }
      const blockLines = fmLines.slice(i + 1, j);

      // Decide flow-style vs block-style by looking at the FIRST non-blank
      // line. If it starts with `{` or `[`, treat the whole block as JSON.
      const firstNonBlank = blockLines.find((l) => l.trim().length > 0)?.trim() ?? "";
      const isFlow = firstNonBlank.startsWith("{") || firstNonBlank.startsWith("[");

      if (isFlow) {
        const joined = blockLines.join("\n").trim();
        const parsed = tryParseFlow(joined);
        if (parsed !== undefined) {
          data[key] = parsed;
          i = j;
          continue;
        }
        // Fall through to block parsing if JSON failed — keep what we can.
      }

      // Block-style map.
      const map: Record<string, unknown> = {};
      for (const blkLine of blockLines) {
        const sub = blkLine.trim();
        if (!sub || sub.startsWith("#") || sub.startsWith("{") || sub.startsWith("[") || sub.startsWith("}") || sub.startsWith("]")) {
          continue;
        }
        const subColon = sub.indexOf(":");
        if (subColon < 0) continue;
        const subKey = sub.slice(0, subColon).trim();
        const subVal = sub.slice(subColon + 1).trim();
        if (subKey) {
          map[subKey] = subVal.length > 0 ? stripQuotes(subVal) : "";
        }
      }
      data[key] = map;
      i = j;
      continue;
    }

    // Inline value — could be plain scalar, JSON object/array, or quoted.
    if (valueRaw.startsWith("{") || valueRaw.startsWith("[")) {
      // Flow value may span multiple lines if it isn't balanced on this one.
      let assembled = valueRaw;
      let j = i + 1;
      while (j < fmLines.length && !isBalanced(assembled)) {
        assembled += "\n" + fmLines[j]!;
        j++;
      }
      const parsed = tryParseFlow(assembled);
      if (parsed !== undefined) {
        data[key] = parsed;
        i = j;
        continue;
      }
      // Fall through: keep as string if JSON parsing failed.
    }
    data[key] = stripQuotes(valueRaw);
    i++;
  }
  return { data, body };
}

function isBalanced(text: string): boolean {
  let curly = 0;
  let square = 0;
  let inStr = false;
  let escape = false;
  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  return curly === 0 && square === 0;
}

/** Tolerant JSON parser: strips trailing commas before } and ]. */
function tryParseFlow(text: string): unknown | undefined {
  const cleaned = text
    .replace(/,(\s*[}\]])/g, "$1") // trailing commas
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Semantic Version validation and utilities (SemVer 2.0.0).
 * Format: MAJOR.MINOR.PATCH (e.g., "1.2.3")
 * Optional prerelease: MAJOR.MINOR.PATCH-prerelease (e.g., "1.2.3-beta.1")
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/;

export type SemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  raw: string;
};

export function parseSemVer(version: string): SemVer | null {
  const match = version.match(SEMVER_RE);
  if (!match) return null;
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
    prerelease: match[4],
    raw: version,
  };
}

export function isValidSemVer(version: string): boolean {
  return parseSemVer(version) !== null;
}

/**
 * Compare two semantic versions.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareSemVer(a: string, b: string): number {
  const va = parseSemVer(a);
  const vb = parseSemVer(b);
  if (!va || !vb) return 0; // Invalid versions are considered equal

  // Compare major.minor.patch
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;

  // Prerelease versions have lower precedence than normal versions
  if (!va.prerelease && vb.prerelease) return 1; // a is release, b is prerelease
  if (va.prerelease && !vb.prerelease) return -1; // a is prerelease, b is release
  if (!va.prerelease && !vb.prerelease) return 0; // Both are releases

  // Compare prerelease identifiers lexicographically
  return va.prerelease!.localeCompare(vb.prerelease!);
}

/**
 * Increment a semantic version.
 * @param version Current version
 * @param part Which part to increment: "major", "minor", or "patch"
 * @returns New version string
 */
export function incrementSemVer(version: string, part: "major" | "minor" | "patch"): string {
  const v = parseSemVer(version);
  if (!v) return "1.0.0"; // Default fallback

  switch (part) {
    case "major":
      return `${v.major + 1}.0.0`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
  }
}

function validateName(name: unknown, folder: string): string | null {
  if (typeof name !== "string") return "frontmatter `name` must be a string";
  if (name.length === 0) return "frontmatter `name` is empty";
  if (name.length > MAX_NAME) return `frontmatter \`name\` exceeds ${MAX_NAME} chars`;
  if (!NAME_RE.test(name)) {
    return "frontmatter `name` must match /^[a-z0-9]+(-[a-z0-9]+)*$/ (lowercase, hyphens, no leading/trailing or consecutive hyphens)";
  }
  if (name !== folder) {
    return `frontmatter \`name\` (${name}) must match the parent folder name (${folder})`;
  }
  return null;
}

function validateDescription(desc: unknown): string | null {
  if (typeof desc !== "string") return "frontmatter `description` must be a string";
  const trimmed = desc.trim();
  if (trimmed.length === 0) return "frontmatter `description` is empty";
  if (desc.length > MAX_DESCRIPTION) {
    return `frontmatter \`description\` exceeds ${MAX_DESCRIPTION} chars`;
  }
  return null;
}

function listResources(skillRoot: string, subdir: string): SkillResource[] {
  const dir = path.join(skillRoot, subdir);
  if (!fs.existsSync(dir)) return [];
  const out: SkillResource[] = [];
  walk(skillRoot, dir, out);
  return out.slice(0, MAX_ASSET_LIST);
}

function walk(root: string, current: string, out: SkillResource[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_ASSET_LIST) return;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks / sockets — security
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    out.push({
      relPath: path.relative(root, full).replace(/\\/g, "/"),
      absPath: full,
      sizeBytes: size,
    });
  }
}

export class SkillLoader {
  private readonly skillsDir: string;
  private readonly reloadEveryMs: number;
  private cache = new Map<string, Skill>();
  private cacheErrors: SkillLoadError[] = [];
  private lastLoadedAtMs = 0;

  constructor(params: { skillsDir: string; reloadEveryMs?: number }) {
    this.skillsDir = path.resolve(params.skillsDir);
    this.reloadEveryMs = params.reloadEveryMs ?? 5_000;
    this.reloadIfStale(true);
  }

  /** Force a reload regardless of cache age. */
  reload(): void {
    this.reloadIfStale(true);
  }

  /** Reload only if more than reloadEveryMs since the last load. */
  private reloadIfStale(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastLoadedAtMs < this.reloadEveryMs) return;
    this.lastLoadedAtMs = now;
    const next = new Map<string, Skill>();
    const errors: SkillLoadError[] = [];
    if (!fs.existsSync(this.skillsDir)) {
      this.cache = next;
      this.cacheErrors = errors;
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    } catch (e) {
      this.cache = next;
      this.cacheErrors = [
        {
          folder: this.skillsDir,
          skillFile: "",
          error: `unable to read skills dir: ${(e as Error).message}`,
        },
      ];
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = entry.name;
      const skillDir = path.join(this.skillsDir, folder);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue; // not a skill folder
      const parsed = this.loadOne(folder, skillDir, skillFile);
      if ("error" in parsed) {
        errors.push({ folder, skillFile, error: parsed.error });
        continue;
      }
      next.set(parsed.id, parsed);
    }
    this.cache = next;
    this.cacheErrors = errors;
  }

  private loadOne(
    folder: string,
    skillDir: string,
    skillFile: string,
  ): Skill | { error: string } {
    let raw = "";
    try {
      const stat = fs.statSync(skillFile);
      if (stat.size > MAX_BODY_BYTES) {
        return { error: `SKILL.md exceeds ${MAX_BODY_BYTES} bytes` };
      }
      raw = fs.readFileSync(skillFile, "utf8");
    } catch (e) {
      return { error: `unable to read SKILL.md: ${(e as Error).message}` };
    }
    const parsed = parseFrontmatter(raw);
    if ("error" in parsed) return { error: parsed.error };

    const nameErr = validateName(parsed.data.name, folder);
    if (nameErr) return { error: nameErr };
    const descErr = validateDescription(parsed.data.description);
    if (descErr) return { error: descErr };

    const id = parsed.data.name as string;

    let license: string | undefined;
    if (parsed.data.license !== undefined) {
      if (typeof parsed.data.license !== "string") {
        return { error: "frontmatter `license` must be a string" };
      }
      license = parsed.data.license;
    }

    let compatibility: string | undefined;
    if (parsed.data.compatibility !== undefined) {
      if (typeof parsed.data.compatibility !== "string") {
        return { error: "frontmatter `compatibility` must be a string" };
      }
      if (parsed.data.compatibility.length > MAX_COMPATIBILITY) {
        return { error: `frontmatter \`compatibility\` exceeds ${MAX_COMPATIBILITY} chars` };
      }
      compatibility = parsed.data.compatibility;
    }

    const allowedToolsRaw = parsed.data["allowed-tools"];
    let allowedTools: string[] = [];
    if (allowedToolsRaw !== undefined) {
      if (typeof allowedToolsRaw !== "string") {
        return { error: "frontmatter `allowed-tools` must be a space-separated string" };
      }
      allowedTools = allowedToolsRaw
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }

    // Version: semantic versioning (SemVer 2.0.0), default "1.0.0"
    let version = "1.0.0";
    if (parsed.data.version !== undefined) {
      if (typeof parsed.data.version !== "string") {
        return { error: "frontmatter `version` must be a string (SemVer format: X.Y.Z)" };
      }
      if (!isValidSemVer(parsed.data.version)) {
        return { error: `frontmatter \`version\` (${parsed.data.version}) must be valid SemVer (e.g., "1.0.0", "2.1.3-beta")` };
      }
      version = parsed.data.version;
    }

    // Deprecated flag and replacement info
    let deprecated = false;
    let deprecationMessage: string | undefined;
    let replacedBy: string | undefined;

    if (parsed.data.deprecated !== undefined) {
      if (typeof parsed.data.deprecated !== "boolean") {
        return { error: "frontmatter `deprecated` must be a boolean" };
      }
      deprecated = parsed.data.deprecated;
    }

    if (deprecated) {
      if (parsed.data.deprecationMessage !== undefined) {
        if (typeof parsed.data.deprecationMessage !== "string") {
          return { error: "frontmatter `deprecationMessage` must be a string" };
        }
        deprecationMessage = parsed.data.deprecationMessage;
      }
      if (parsed.data.replacedBy !== undefined) {
        if (typeof parsed.data.replacedBy !== "string") {
          return { error: "frontmatter `replacedBy` must be a string (skill ID)" };
        }
        replacedBy = parsed.data.replacedBy;
      }
    }

    // metadata: keep nested values as-is (object/string/etc). Unknown
    // top-level frontmatter keys (homepage, vendor-specific, ...) are
    // folded into metadata so callers can still see them.
    const metadata: Record<string, unknown> = {};
    const metadataRaw = parsed.data.metadata;
    if (metadataRaw !== undefined) {
      if (!metadataRaw || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) {
        return { error: "frontmatter `metadata` must be a key-value map" };
      }
      for (const [k, v] of Object.entries(metadataRaw as Record<string, unknown>)) {
        metadata[k] = v;
      }
    }
    const SPEC_KEYS = new Set([
      "name", "description", "license", "compatibility", "metadata", "allowed-tools",
      "version", "deprecated", "deprecationMessage", "replacedBy",
    ]);
    for (const [k, v] of Object.entries(parsed.data)) {
      if (!SPEC_KEYS.has(k) && !(k in metadata)) {
        metadata[k] = v;
      }
    }

    const scripts = listResources(skillDir, "scripts");
    const references = listResources(skillDir, "references");
    const assets = listResources(skillDir, "assets");

    return {
      id,
      description: parsed.data.description as string,
      license,
      compatibility,
      allowedTools,
      metadata,
      skillDir,
      skillFile,
      instructions: parsed.body,
      scripts,
      references,
      assets,
      version,
      deprecated,
      deprecationMessage,
      replacedBy,
    };
  }

  /** Discovery tier — name + description only (cheap to ship into a system prompt). */
  list(): SkillMetadata[] {
    this.reloadIfStale();
    return Array.from(this.cache.values())
      .map((skill) => ({
        id: skill.id,
        description: skill.description,
        license: skill.license,
        compatibility: skill.compatibility,
        allowedTools: skill.allowedTools,
        metadata: skill.metadata,
        skillDir: skill.skillDir,
        skillFile: skill.skillFile,
        version: skill.version,
        deprecated: skill.deprecated,
        deprecationMessage: skill.deprecationMessage,
        replacedBy: skill.replacedBy,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Activation tier — full instructions + resource paths. */
  get(id: string): Skill | null {
    this.reloadIfStale();
    return this.cache.get(id) ?? null;
  }

  /** Skills that failed to load on the last scan — surface to the user. */
  errors(): SkillLoadError[] {
    this.reloadIfStale();
    return this.cacheErrors.slice();
  }

  /** Skills directory currently scanned. */
  dirForDebug(): string {
    return this.skillsDir;
  }

  /**
   * Resource tier — load a specific file under a skill. Refuses anything
   * that escapes the skill directory (path traversal, absolute path,
   * symlink leaving the sandbox). Refuses files > maxBytes.
   */
  readAsset(
    skillId: string,
    relPath: string,
    options: { maxBytes?: number; encoding?: BufferEncoding | "binary" } = {},
  ): { ok: true; bytes: number; content: string } | { ok: false; error: string } {
    const skill = this.get(skillId);
    if (!skill) return { ok: false, error: `skill '${skillId}' not found` };
    const maxBytes = options.maxBytes ?? 256 * 1024;
    const cleanRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (cleanRel.includes("..") || path.isAbsolute(cleanRel)) {
      return { ok: false, error: "asset path must be relative and inside the skill folder" };
    }
    const target = path.resolve(skill.skillDir, cleanRel);
    const resolvedSkillDir = path.resolve(skill.skillDir);
    if (!target.startsWith(resolvedSkillDir + path.sep) && target !== resolvedSkillDir) {
      return { ok: false, error: "asset path escapes the skill folder" };
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (e) {
      return { ok: false, error: `unable to stat asset: ${(e as Error).message}` };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, error: "asset is a symlink; refusing for safety" };
    }
    if (!stat.isFile()) {
      return { ok: false, error: "asset is not a regular file" };
    }
    if (stat.size > maxBytes) {
      return { ok: false, error: `asset exceeds maxBytes=${maxBytes} (size=${stat.size})` };
    }
    try {
      const encoding = options.encoding === "binary" ? "base64" : options.encoding ?? "utf8";
      const buf = fs.readFileSync(target);
      return {
        ok: true,
        bytes: stat.size,
        content:
          encoding === "base64"
            ? buf.toString("base64")
            : buf.toString(encoding as BufferEncoding),
      };
    } catch (e) {
      return { ok: false, error: `unable to read asset: ${(e as Error).message}` };
    }
  }
}
