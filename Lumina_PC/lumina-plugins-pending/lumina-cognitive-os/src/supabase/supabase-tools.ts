/**
 * Supabase tools for Lumina/OpenClaw.
 *
 * These tools intentionally use Supabase's REST/PostgREST API instead of a
 * client dependency so the extension stays lightweight inside the WSL gateway.
 * Read operations are enabled by default. Writes require
 * LUMINA_SUPABASE_ALLOW_WRITES=true. Inserts/upserts are allowed for Lumina's
 * own persistence. Updates/deletes also require confirm=true.
 */
import { Type } from "typebox";

import { jsonResult, ToolAuthorizationError, ToolInputError, type AnyAgentTool } from "../shared/tool-result.js";
import {
  assertSupabaseIdentifier,
  getSupabaseProjectRef,
  readSupabaseJson,
  resolveSupabaseConfig,
  supabaseFetch,
  type SupabaseConfigOptions,
} from "./supabase-client.js";

type ToolDeps = SupabaseConfigOptions;

const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "cs",
  "cd",
  "ov",
] as const;

type FilterOp = (typeof FILTER_OPS)[number];

type SupabaseFilter = {
  column: string;
  op?: FilterOp;
  value?: unknown;
};

type OpenApiSchema = {
  paths?: Record<string, unknown>;
  definitions?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  components?: {
    schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  };
};

const SELECT_RE = /^[A-Za-z0-9_*,.():! \-]+$/u;
const ORDER_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:asc|desc))?(?:\.(?:nullsfirst|nullslast))?$/u;

function errorResult(err: unknown) {
  return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
}

function clampLimit(value: unknown, maxRows: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(50, maxRows);
  }
  return Math.min(Math.trunc(value), maxRows);
}

function validateSelect(select: string): string {
  const trimmed = select.trim();
  if (!trimmed || trimmed.length > 600 || !SELECT_RE.test(trimmed)) {
    throw new ToolInputError("select must be a safe PostgREST select expression");
  }
  return trimmed;
}

function validateOrder(order: string | undefined): string | undefined {
  if (!order) return undefined;
  const trimmed = order.trim();
  if (!ORDER_RE.test(trimmed)) {
    throw new ToolInputError("order must look like column.asc or column.desc");
  }
  return trimmed;
}

function serializeScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new ToolInputError("filter values must be strings, numbers, booleans, null, or arrays for in");
}

export function serializeSupabaseFilter(filter: SupabaseFilter): [string, string] {
  const column = filter.column?.trim();
  if (!column) throw new ToolInputError("filter.column is required");
  assertSupabaseIdentifier(column, "filter.column");
  const op = filter.op ?? "eq";
  if (!FILTER_OPS.includes(op)) {
    throw new ToolInputError(`unsupported filter op ${String(op)}`);
  }
  if (op === "in") {
    if (!Array.isArray(filter.value) || filter.value.length === 0) {
      throw new ToolInputError("in filters require a non-empty array value");
    }
    const values = filter.value.map(serializeScalar).join(",");
    return [column, `in.(${values})`];
  }
  if (op === "is") {
    const value = filter.value === undefined ? null : filter.value;
    return [column, `is.${serializeScalar(value)}`];
  }
  if (filter.value === undefined) {
    throw new ToolInputError("filter.value is required");
  }
  return [column, `${op}.${serializeScalar(filter.value)}`];
}

function appendFilters(params: URLSearchParams, filters: SupabaseFilter[] | undefined): void {
  for (const filter of filters ?? []) {
    const [column, value] = serializeSupabaseFilter(filter);
    params.append(column, value);
  }
}

function extractOpenApiTables(openapi: OpenApiSchema) {
  const definitions = openapi.definitions ?? openapi.components?.schemas ?? {};
  const pathTables = new Set(
    Object.keys(openapi.paths ?? {})
      .map((p) => p.replace(/^\/+/u, "").split("/")[0])
      .filter((name) => name && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
  );
  return [...pathTables].sort().map((name) => {
    const definition = definitions[name] ?? {};
    const properties = definition.properties ?? {};
    return {
      name,
      columns: Object.entries(properties).map(([column, meta]) => ({
        name: column,
        ...(typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {}),
      })),
      required: definition.required ?? [],
    };
  });
}

export function createSupabaseStatusTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_supabase_status",
    label: "Lumina Supabase Status",
    description:
      "Checks whether Lumina can reach Supabase using the credentials in c:/I24D_WhatsApp/.env. " +
      "Never prints the API key.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const response = await supabaseFetch(cfg, "/rest/v1/", {
          method: "GET",
          acceptOpenApi: true,
          timeoutMs: 10_000,
        });
        return jsonResult({
          ok: response.ok,
          status: response.status,
          projectRef: getSupabaseProjectRef(cfg.url),
          schema: cfg.schema,
          keySource: cfg.keySource,
          allowWrites: cfg.allowWrites,
          maxRows: cfg.maxRows,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export function createSupabaseSchemaTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_supabase_schema",
    label: "Lumina Supabase Schema",
    description:
      "Lists tables and columns exposed by Supabase/PostgREST for the configured schema. " +
      "Use this before querying unfamiliar tables.",
    parameters: Type.Object({
      includeColumns: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, raw) {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const response = await supabaseFetch(cfg, "/rest/v1/", {
          method: "GET",
          acceptOpenApi: true,
          timeoutMs: 15_000,
        });
        const parsed = await readSupabaseJson<OpenApiSchema>(response);
        if (!parsed.ok) return jsonResult({ ok: false, error: parsed.error, status: parsed.status });
        const tables = extractOpenApiTables(parsed.data);
        const includeColumns = raw.includeColumns !== false;
        return jsonResult({
          ok: true,
          schema: cfg.schema,
          tableCount: tables.length,
          tables: includeColumns
            ? tables
            : tables.map((table) => ({ name: table.name, columnCount: table.columns.length })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export function createSupabaseQueryTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_supabase_query",
    label: "Lumina Supabase Query",
    description:
      "Read rows from a Supabase table through PostgREST. Supports safe filters, select, order, and limit. " +
      "Use lumina_supabase_schema first if you do not know the table/columns.",
    parameters: Type.Object({
      table: Type.String({ minLength: 1, maxLength: 120 }),
      select: Type.Optional(Type.String({ maxLength: 600, default: "*" })),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            column: Type.String({ minLength: 1, maxLength: 120 }),
            op: Type.Optional(Type.Union(FILTER_OPS.map((op) => Type.Literal(op)))),
            value: Type.Optional(Type.Unknown()),
          }),
          { maxItems: 16 },
        ),
      ),
      order: Type.Optional(Type.String({ maxLength: 160 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    async execute(_id, raw) {
      try {
        const cfg = resolveSupabaseConfig(deps);
        const table = String(raw.table ?? "").trim();
        assertSupabaseIdentifier(table, "table");
        const select = validateSelect(typeof raw.select === "string" ? raw.select : "*");
        const limit = clampLimit(raw.limit, cfg.maxRows);
        const params = new URLSearchParams();
        params.set("select", select);
        params.set("limit", String(limit));
        const order = validateOrder(typeof raw.order === "string" ? raw.order : undefined);
        if (order) params.set("order", order);
        appendFilters(params, raw.filters as SupabaseFilter[] | undefined);

        const response = await supabaseFetch(
          cfg,
          `/rest/v1/${encodeURIComponent(table)}?${params.toString()}`,
          {
            method: "GET",
            headers: { prefer: "count=exact" },
            timeoutMs: 20_000,
          },
        );
        const parsed = await readSupabaseJson<unknown[]>(response);
        if (!parsed.ok) return jsonResult({ ok: false, error: parsed.error, status: parsed.status });
        return jsonResult({
          ok: true,
          table,
          schema: cfg.schema,
          count: parsed.data.length,
          contentRange: response.headers.get("content-range"),
          rows: parsed.data,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

export function createSupabaseMutateTool(deps: ToolDeps): AnyAgentTool {
  return {
    name: "lumina_supabase_mutate",
    label: "Lumina Supabase Mutate",
    description:
      "Insert, upsert, update, or delete Supabase rows. Requires LUMINA_SUPABASE_ALLOW_WRITES=true. " +
      "Insert/upsert are for Lumina-owned persistence; update/delete require confirm=true.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("insert"),
        Type.Literal("upsert"),
        Type.Literal("update"),
        Type.Literal("delete"),
      ]),
      table: Type.String({ minLength: 1, maxLength: 120 }),
      rows: Type.Optional(Type.Unknown()),
      filters: Type.Optional(
        Type.Array(
          Type.Object({
            column: Type.String({ minLength: 1, maxLength: 120 }),
            op: Type.Optional(Type.Union(FILTER_OPS.map((op) => Type.Literal(op)))),
            value: Type.Optional(Type.Unknown()),
          }),
          { maxItems: 16 },
        ),
      ),
      select: Type.Optional(Type.String({ maxLength: 600, default: "*" })),
      onConflict: Type.Optional(Type.String({ maxLength: 160 })),
      confirm: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, raw) {
      try {
        const cfg = resolveSupabaseConfig(deps);
        if (!cfg.allowWrites) {
          throw new ToolAuthorizationError(
            "Supabase writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to enable.",
          );
        }
        const action = String(raw.action);
        const table = String(raw.table ?? "").trim();
        assertSupabaseIdentifier(table, "table");
        const params = new URLSearchParams();
        params.set("select", validateSelect(typeof raw.select === "string" ? raw.select : "*"));
        appendFilters(params, raw.filters as SupabaseFilter[] | undefined);

        let method: "POST" | "PATCH" | "DELETE";
        let body: string | undefined;
        const headers: Record<string, string> = { prefer: "return=representation" };

        if (action === "insert" || action === "upsert") {
          method = "POST";
          if (raw.rows === undefined) throw new ToolInputError("rows is required");
          body = JSON.stringify(raw.rows);
          if (action === "upsert") {
            headers.prefer = "resolution=merge-duplicates,return=representation";
            if (typeof raw.onConflict === "string" && raw.onConflict.trim()) {
              params.set("on_conflict", raw.onConflict.trim());
            }
          }
        } else if (action === "update") {
          if (raw.confirm !== true) {
            throw new ToolAuthorizationError("confirm=true is required for Supabase update");
          }
          method = "PATCH";
          if (raw.rows === undefined) throw new ToolInputError("rows is required");
          if (!Array.isArray(raw.filters) || raw.filters.length === 0) {
            throw new ToolInputError("update requires at least one filter");
          }
          body = JSON.stringify(raw.rows);
        } else if (action === "delete") {
          if (raw.confirm !== true) {
            throw new ToolAuthorizationError("confirm=true is required for Supabase delete");
          }
          method = "DELETE";
          if (!Array.isArray(raw.filters) || raw.filters.length === 0) {
            throw new ToolInputError("delete requires at least one filter");
          }
        } else {
          throw new ToolInputError(`unknown action ${action}`);
        }

        const response = await supabaseFetch(
          cfg,
          `/rest/v1/${encodeURIComponent(table)}?${params.toString()}`,
          { method, body, headers, timeoutMs: 20_000 },
        );
        const parsed = await readSupabaseJson<unknown[]>(response);
        if (!parsed.ok) return jsonResult({ ok: false, error: parsed.error, status: parsed.status });
        return jsonResult({ ok: true, action, table, rows: parsed.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
