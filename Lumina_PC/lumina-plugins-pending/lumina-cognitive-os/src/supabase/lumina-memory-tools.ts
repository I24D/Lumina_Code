import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  jsonResult,
  ToolAuthorizationError,
  ToolInputError,
  type AnyAgentTool,
} from "../shared/tool-result.js";
import {
  getSupabaseProjectRef,
  readSupabaseJson,
  resolveSupabaseConfig,
  supabaseFetch,
  type SupabaseConfig,
  type SupabaseConfigOptions,
} from "./supabase-client.js";

type ToolDeps = SupabaseConfigOptions & {
  readonly warehousesPath?: string;
};

const DEFAULT_WAREHOUSES_PATH = "c:/I24D_WhatsApp/src/cuerpo/warehouses";
const LUMINA_MEMORY_TABLES = [
  "long_term_memories",
  "knowledge_entries",
  "interaction_log",
  "lumina_state_documents",
] as const;

type MemoryTable = (typeof LUMINA_MEMORY_TABLES)[number];

const MEMORY_KIND_VALUES = [
  "fact",
  "preference",
  "procedure",
  "workspace",
  "pc_state",
  "relationship",
  "correction",
  "note",
] as const;

const WAREHOUSE_PARTITIONS = [
  ["1.1", "formal_sciences"],
  ["1.2", "natural_sciences"],
  ["1.3", "social_sciences"],
  ["1.4", "humanities"],
  ["1.5", "applied_sciences"],
  ["1.6", "arts"],
] as const;

function errorResult(err: unknown) {
  return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
}

function parseContentRange(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\/(\d+)$/u);
  return match ? Number(match[1]) : null;
}

function clampLimit(value: unknown, fallback: number, maxRows: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(fallback, maxRows);
  }
  return Math.min(Math.trunc(value), maxRows);
}

function sanitizeSearchTerm(value: unknown): string {
  return String(value ?? "")
    .replace(/[(),]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

function textSnippet(value: unknown, max = 700): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.replace(/\s+/gu, " ").trim().slice(0, max);
}

function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function maybeDecodePayload(value: unknown): string {
  if (typeof value !== "string" || value.length < 12) return typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9+/=\r\n]+$/u.test(value) || value.length % 4 !== 0) return value;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const printable = decoded.replace(/[\t\r\n -~]/gu, "");
    if (decoded.length > 0 && printable.length / decoded.length < 0.15) return decoded;
  } catch {
    // Not base64 text.
  }
  return value;
}

function normalizeLongTermMemory(row: Record<string, unknown>) {
  const parsed = maybeParseJson(row.summary);
  const parsedObj =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const meta =
    typeof parsedObj?.meta === "object" && parsedObj.meta !== null
      ? (parsedObj.meta as Record<string, unknown>)
      : {};
  const payload = maybeDecodePayload(parsedObj?.payload);
  const summary = textSnippet(
    meta.summary ?? parsedObj?.summary ?? parsedObj?.payload ?? row.summary,
    500,
  );
  const userId = String(row.user_id ?? "");
  return {
    table: "long_term_memories",
    id: row.id,
    userId,
    warehouseId:
      parsedObj?.warehouseId ?? (userId.includes("::") ? userId.split("::")[0] : "legacy"),
    partition:
      parsedObj?.partition ??
      (userId.includes("::") ? userId.split("::").slice(1).join("::") : userId),
    type: parsedObj?.type ?? meta.kind ?? null,
    domain: parsedObj?.domain ?? null,
    language: parsedObj?.language ?? null,
    source: meta.sourceId ?? meta.source ?? null,
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 12) : [],
    createdAt: row.created_at,
    summary,
    snippet: payload ? textSnippet(payload, 700) : summary,
  };
}

function normalizeKnowledgeEntry(row: Record<string, unknown>) {
  return {
    table: "knowledge_entries",
    id: row.id,
    source: row.source ?? null,
    confidence: row.confidence ?? null,
    createdAt: row.created_at,
    summary: textSnippet(row.question, 300),
    snippet: textSnippet(row.answer, 900),
  };
}

function normalizeInteraction(row: Record<string, unknown>) {
  return {
    table: "interaction_log",
    id: row.id,
    userId: row.user_id ?? null,
    isPoor: row.is_poor ?? null,
    createdAt: row.created_at,
    summary: textSnippet(row.user_message, 360),
    snippet: textSnippet(row.reply, 900),
  };
}

function normalizeStateDocument(row: Record<string, unknown>) {
  return {
    table: "lumina_state_documents",
    workspaceId: row.workspace_id,
    scope: row.scope,
    key: row.document_key,
    updatedAt: row.updated_at,
    summary: `${row.scope ?? "state"}:${row.document_key ?? ""}`,
    snippet: textSnippet(row.payload, 900),
  };
}

export function normalizeLuminaMemoryRow(table: MemoryTable, row: Record<string, unknown>) {
  if (table === "long_term_memories") return normalizeLongTermMemory(row);
  if (table === "knowledge_entries") return normalizeKnowledgeEntry(row);
  if (table === "interaction_log") return normalizeInteraction(row);
  return normalizeStateDocument(row);
}

async function countRows(
  cfg: SupabaseConfig,
  table: string,
  filters: Record<string, string> = {},
): Promise<{ ok: boolean; count: number | null; status: number; error?: string }> {
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("limit", "1");
  for (const [key, value] of Object.entries(filters)) params.set(key, value);
  const response = await supabaseFetch(cfg, `/rest/v1/${table}?${params.toString()}`, {
    method: "GET",
    headers: { prefer: "count=exact" },
    timeoutMs: 10_000,
  });
  if (!response.ok && response.status !== 206) {
    return {
      ok: false,
      count: null,
      status: response.status,
      error: await response.text().catch(() => ""),
    };
  }
  return {
    ok: true,
    count: parseContentRange(response.headers.get("content-range")),
    status: response.status,
  };
}

async function fetchMemoryRows(
  cfg: SupabaseConfig,
  table: MemoryTable,
  params: URLSearchParams,
): Promise<
  { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string; status: number }
> {
  const response = await supabaseFetch(cfg, `/rest/v1/${table}?${params.toString()}`, {
    method: "GET",
    timeoutMs: 20_000,
  });
  const parsed = await readSupabaseJson<Record<string, unknown>[]>(response);
  return parsed.ok
    ? { ok: true, rows: parsed.data }
    : { ok: false, error: parsed.error, status: parsed.status };
}

function appendSearchFilter(table: MemoryTable, params: URLSearchParams, term: string): void {
  if (!term) return;
  const pattern = `*${term}*`;
  if (table === "long_term_memories") {
    params.set("summary", `ilike.${pattern}`);
  } else if (table === "knowledge_entries") {
    params.set("or", `(question.ilike.${pattern},answer.ilike.${pattern},source.ilike.${pattern})`);
  } else if (table === "interaction_log") {
    params.set("or", `(user_message.ilike.${pattern},reply.ilike.${pattern})`);
  } else {
    params.set("or", `(scope.ilike.${pattern},document_key.ilike.${pattern})`);
  }
}

function appendWarehouseFilter(params: URLSearchParams, warehouse: string | undefined): void {
  if (!warehouse || warehouse === "all" || warehouse === "legacy") return;
  const prefix = warehouse === "lumina_openclaw" ? "lumina_openclaw" : warehouse;
  params.set("user_id", `like.${prefix}::*`);
}

function buildMemorySummary(input: {
  kind: string;
  text: string;
  tags: string[];
  source: string;
  importance: number;
}) {
  const tags = input.tags.length ? ` tags=${input.tags.join(",")}` : "";
  return `[LUMINA_OPENCLAW_MEMORY] kind=${input.kind} importance=${input.importance}${tags} source=${input.source} :: ${input.text}`;
}

function resolveCanonicalUserId(value?: unknown): string {
  return (
    String(value ?? "").trim() ||
    String(process.env.LUMINA_CANONICAL_USER_ID ?? "").trim() ||
    "lumina-user:owner"
  );
}

function memoryIdFor(input: {
  userId: string;
  kind: string;
  text: string;
  tags: string[];
  source: string;
}) {
  const hash = crypto
    .createHash("sha256")
    .update(
      `${input.userId}\n${input.kind}\n${input.source}\n${input.tags.join(",")}\n${input.text}`,
    )
    .digest("hex")
    .slice(0, 20);
  return `locm_${hash}`;
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((tag) =>
          String(tag ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].slice(0, 16);
}

function resolveHostPath(input: string): string {
  const normalized = input.replace(/\\/gu, "/");
  const drive = normalized.match(/^([a-zA-Z]):\/(.+)$/u);
  if (drive && process.platform !== "win32") {
    return `/mnt/${drive[1]?.toLowerCase()}/${drive[2]}`;
  }
  return path.resolve(input);
}

function listChildDirs(root: string, rel = "", limit = 40): string[] {
  const target = path.join(root, rel);
  try {
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function buildWarehouseCatalog(rootInput: string, maxItems: number) {
  const root = resolveHostPath(rootInput);
  const exists = fs.existsSync(root);
  const warehouseA = WAREHOUSE_PARTITIONS.map(([folder, domain]) => {
    const repos = listChildDirs(root, path.join("warehouseA", folder), maxItems);
    return { folder, domain, repoCount: repos.length, sampleRepos: repos.slice(0, 12) };
  });
  const warehouseCodexRepos = listChildDirs(
    root,
    path.join("warehouseCodex", "down_repos"),
    maxItems,
  );
  return {
    generatedAt: new Date().toISOString(),
    root: rootInput,
    resolvedRoot: root,
    exists,
    recommendation:
      "Keep src/cuerpo/warehouses in place. Use Supabase as persistent memory and catalog/index only lightweight summaries for OpenClaw.",
    warehouseA,
    warehouseB: {
      topLevel: listChildDirs(root, "warehouseB", maxItems),
    },
    warehouseCodex: {
      topLevel: listChildDirs(root, "warehouseCodex", maxItems),
      downReposCount: warehouseCodexRepos.length,
      sampleRepos: warehouseCodexRepos.slice(0, 16),
    },
    shared: {
      files: exists
        ? ["index.ts", "shared/warehouseBase.ts", "shared/warehouseTypes.ts"].filter((file) =>
            fs.existsSync(path.join(root, file)),
          )
        : [],
    },
  };
}

export function createLuminaMemoryStatusTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_memory_status",
    label: "Lumina Memory Status",
    description:
      "Summarizes Lumina's Supabase memory tables and known warehouse partitions. Use before memory search.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const [longTerm, knowledge, interactions, state, whA, whB, whCodex, openclaw] =
          await Promise.all([
            countRows(cfg, "long_term_memories"),
            countRows(cfg, "knowledge_entries"),
            countRows(cfg, "interaction_log"),
            countRows(cfg, "lumina_state_documents"),
            countRows(cfg, "long_term_memories", { user_id: "like.warehouse_a::*" }),
            countRows(cfg, "long_term_memories", { user_id: "like.warehouse_b::*" }),
            countRows(cfg, "long_term_memories", { user_id: "like.warehouse_codex::*" }),
            countRows(cfg, "long_term_memories", { user_id: "like.lumina_openclaw::*" }),
          ]);
        return jsonResult({
          ok: true,
          projectRef: getSupabaseProjectRef(cfg.url),
          schema: cfg.schema,
          allowWrites: cfg.allowWrites,
          tables: {
            long_term_memories: longTerm.count,
            knowledge_entries: knowledge.count,
            interaction_log: interactions.count,
            lumina_state_documents: state.count,
          },
          warehousePartitions: {
            warehouse_a: whA.count,
            warehouse_b: whB.count,
            warehouse_codex: whCodex.count,
            lumina_openclaw: openclaw.count,
          },
          note: "OpenClaw should use these Supabase-backed tools instead of loading experimental local cerebro modules.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export function createLuminaMemorySearchTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_memory_search",
    label: "Lumina Memory Search",
    description:
      "Searches Lumina's Supabase memory: long-term memories, knowledge entries, interactions, and state documents.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 240 })),
      userId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      tables: Type.Optional(
        Type.Array(Type.Union(LUMINA_MEMORY_TABLES.map((table) => Type.Literal(table))), {
          maxItems: LUMINA_MEMORY_TABLES.length,
        }),
      ),
      warehouse: Type.Optional(
        Type.Union([
          Type.Literal("all"),
          Type.Literal("legacy"),
          Type.Literal("warehouse_a"),
          Type.Literal("warehouse_b"),
          Type.Literal("warehouse_codex"),
          Type.Literal("lumina_openclaw"),
        ]),
      ),
      limitPerTable: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, raw) {
      try {
        const input = raw as {
          query?: unknown;
          userId?: unknown;
          tables?: unknown;
          warehouse?:
            | "all"
            | "legacy"
            | "warehouse_a"
            | "warehouse_b"
            | "warehouse_codex"
            | "lumina_openclaw";
          limitPerTable?: unknown;
        };
        const cfg = resolveSupabaseConfig(deps);
        const term = sanitizeSearchTerm(input.query);
        const userId = resolveCanonicalUserId(input.userId);
        const tables =
          Array.isArray(input.tables) && input.tables.length
            ? (input.tables as MemoryTable[]).filter((table) =>
                LUMINA_MEMORY_TABLES.includes(table),
              )
            : (["long_term_memories", "knowledge_entries", "interaction_log"] as MemoryTable[]);
        const limit = clampLimit(input.limitPerTable, 8, cfg.maxRows);
        const results: unknown[] = [];
        const errors: unknown[] = [];

        for (const table of tables) {
          const params = new URLSearchParams();
          params.set("select", "*");
          params.set("limit", String(limit));
          if (table === "long_term_memories") {
            params.set("order", "created_at.desc");
            if (input.warehouse && input.warehouse !== "all") {
              appendWarehouseFilter(params, input.warehouse);
            } else {
              params.set("user_id", `eq.${userId}`);
            }
          } else if (table === "interaction_log") {
            params.set("order", "created_at.desc");
            params.set("user_id", `eq.${userId}`);
          } else if (table === "lumina_state_documents") {
            params.set("order", "updated_at.desc");
          } else {
            params.set("order", "created_at.desc");
          }
          appendSearchFilter(table, params, term);
          const fetched = await fetchMemoryRows(cfg, table, params);
          if (!fetched.ok) {
            errors.push({ table, status: fetched.status, error: fetched.error });
            continue;
          }
          for (const row of fetched.rows) {
            const normalized = normalizeLuminaMemoryRow(table, row);
            if (input.warehouse === "legacy" && normalized.table === "long_term_memories") {
              const userId = String((normalized as { userId?: unknown }).userId ?? "");
              if (userId.includes("::")) continue;
            }
            results.push(normalized);
          }
        }

        return jsonResult({
          ok: errors.length === 0,
          query: term,
          userId,
          count: results.length,
          results,
          errors,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export function createLuminaMemoryRememberTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_supabase_memory_remember",
    label: "Lumina Memory Remember",
    description:
      "Stores a durable learning for Lumina/OpenClaw in Supabase. This is the preferred way for OpenClaw to remember.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 6000 }),
      userId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      kind: Type.Optional(Type.Union(MEMORY_KIND_VALUES.map((kind) => Type.Literal(kind)))),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 16 })),
      source: Type.Optional(Type.String({ maxLength: 120 })),
      importance: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
      question: Type.Optional(Type.String({ maxLength: 1000 })),
      alsoKnowledgeEntry: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, raw) {
      try {
        const input = raw as {
          text?: unknown;
          userId?: unknown;
          kind?: (typeof MEMORY_KIND_VALUES)[number];
          tags?: unknown;
          source?: unknown;
          importance?: unknown;
          question?: unknown;
          alsoKnowledgeEntry?: boolean;
        };
        const cfg = resolveSupabaseConfig(deps);
        if (!cfg.allowWrites) {
          throw new ToolAuthorizationError(
            "Lumina memory writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to enable.",
          );
        }
        const text = String(input.text ?? "").trim();
        if (!text) throw new ToolInputError("text is required");
        const kind = input.kind && MEMORY_KIND_VALUES.includes(input.kind) ? input.kind : "note";
        const tags = normalizeTags(input.tags);
        const source = String(input.source ?? "openclaw").trim() || "openclaw";
        const userId = resolveCanonicalUserId(input.userId);
        const importance =
          typeof input.importance === "number" && Number.isFinite(input.importance)
            ? Math.max(1, Math.min(5, Math.trunc(input.importance)))
            : 3;
        const id = memoryIdFor({ userId, kind, text, tags, source });
        const summary = buildMemorySummary({ kind, text, tags, source, importance });
        const createdAt = new Date().toISOString();
        const row = {
          id,
          user_id: userId,
          summary,
          embedding: null,
          message_count: 0,
          created_at: createdAt,
        };

        const memoryResponse = await supabaseFetch(
          cfg,
          "/rest/v1/long_term_memories?select=id,user_id,summary,created_at",
          {
            method: "POST",
            headers: { prefer: "return=representation" },
            body: JSON.stringify(row),
            timeoutMs: 20_000,
          },
        );
        const memoryParsed = await readSupabaseJson<unknown[]>(memoryResponse);
        if (!memoryParsed.ok) {
          return jsonResult({
            ok: false,
            table: "long_term_memories",
            error: memoryParsed.error,
            status: memoryParsed.status,
          });
        }

        let knowledgeEntry: unknown[] | null = null;
        const shouldWriteKnowledge =
          input.alsoKnowledgeEntry === true || typeof input.question === "string";
        if (shouldWriteKnowledge) {
          const question = String(input.question ?? (tags.join(" ") || text.slice(0, 240))).trim();
          const knowledgeResponse = await supabaseFetch(
            cfg,
            "/rest/v1/knowledge_entries?on_conflict=id&select=id,question,source,confidence,created_at",
            {
              method: "POST",
              headers: { prefer: "resolution=merge-duplicates,return=representation" },
              body: JSON.stringify({
                id: `ke_${id.slice(5)}`,
                question,
                answer: text,
                embedding: null,
                source: `lumina_openclaw:${source}`,
                confidence: importance / 5,
                created_at: createdAt,
              }),
              timeoutMs: 20_000,
            },
          );
          const knowledgeParsed = await readSupabaseJson<unknown[]>(knowledgeResponse);
          if (!knowledgeParsed.ok) {
            return jsonResult({
              ok: false,
              memory: memoryParsed.data,
              table: "knowledge_entries",
              error: knowledgeParsed.error,
              status: knowledgeParsed.status,
            });
          }
          knowledgeEntry = knowledgeParsed.data;
        }

        return jsonResult({
          ok: true,
          id,
          userId: row.user_id,
          memory: memoryParsed.data,
          knowledgeEntry,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export function createLuminaWarehouseCatalogTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_warehouse_catalog",
    label: "Lumina Warehouse Catalog",
    description:
      "Catalogs src/cuerpo/warehouses without loading local AI/cerebro modules. Optionally persists the catalog in Supabase state.",
    parameters: Type.Object({
      warehousesPath: Type.Optional(Type.String({ maxLength: 500 })),
      maxItems: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      writeToSupabase: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, raw) {
      try {
        const input = raw as {
          warehousesPath?: unknown;
          maxItems?: unknown;
          writeToSupabase?: boolean;
        };
        const cfg = resolveSupabaseConfig(deps);
        const root = String(input.warehousesPath ?? deps.warehousesPath ?? DEFAULT_WAREHOUSES_PATH);
        const catalog = buildWarehouseCatalog(root, clampLimit(input.maxItems, 40, 200));

        if (input.writeToSupabase === true) {
          if (!cfg.allowWrites) {
            throw new ToolAuthorizationError(
              "Supabase writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to persist the warehouse catalog.",
            );
          }
          const response = await supabaseFetch(
            cfg,
            "/rest/v1/lumina_state_documents?on_conflict=workspace_id,scope,document_key&select=workspace_id,scope,document_key,updated_at",
            {
              method: "POST",
              headers: { prefer: "resolution=merge-duplicates,return=representation" },
              body: JSON.stringify({
                workspace_id: "lumina",
                scope: "warehouse",
                document_key: "catalog",
                payload: catalog,
                updated_at: new Date().toISOString(),
              }),
              timeoutMs: 20_000,
            },
          );
          const parsed = await readSupabaseJson<unknown[]>(response);
          if (!parsed.ok) {
            return jsonResult({ ok: false, catalog, error: parsed.error, status: parsed.status });
          }
          return jsonResult({ ok: true, persisted: true, catalog, stateDocument: parsed.data });
        }

        return jsonResult({ ok: true, persisted: false, catalog });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
