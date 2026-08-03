import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseMutateTool, createSupabaseQueryTool, serializeSupabaseFilter } from "./supabase-tools.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("Lumina Supabase tools", () => {
  it("serializes safe PostgREST filters", () => {
    expect(serializeSupabaseFilter({ column: "email", op: "ilike", value: "%@example.com" })).toEqual([
      "email",
      "ilike.%@example.com",
    ]);
    expect(serializeSupabaseFilter({ column: "id", op: "in", value: [1, 2, 3] })).toEqual([
      "id",
      "in.(1,2,3)",
    ]);
  });

  it("runs read-only table queries without exposing credentials", async () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 1, email: "dal@example.com" }]), {
        status: 200,
        headers: { "content-range": "0-0/1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSupabaseQueryTool({ schema: "public", maxRows: 25 });
    const result = await tool.execute("tool-call", {
      table: "contacts",
      select: "id,email",
      filters: [{ column: "email", op: "ilike", value: "%@example.com" }],
      limit: 100,
      order: "id.desc",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://project.supabase.co/rest/v1/contacts?");
    expect(url).toContain("select=id%2Cemail");
    expect(url).toContain("limit=25");
    expect(url).toContain("email=ilike.%25%40example.com");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer test-service-role");
    expect(JSON.stringify(result.details)).not.toContain("test-service-role");
    expect(result.details).toMatchObject({
      ok: true,
      table: "contacts",
      count: 1,
    });
  });

  it("blocks writes when disabled", async () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    delete process.env.LUMINA_SUPABASE_ALLOW_WRITES;
    const tool = createSupabaseMutateTool({ schema: "public", allowWrites: false });

    const result = await tool.execute("tool-call", {
      action: "insert",
      table: "contacts",
      rows: { email: "dal@example.com" },
      confirm: true,
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: "Supabase writes are disabled. Set LUMINA_SUPABASE_ALLOW_WRITES=true to enable.",
    });
  });

  it("allows inserts when Lumina Supabase writes are enabled", async () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 1, kind: "memory" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSupabaseMutateTool({ schema: "public", allowWrites: true });
    const result = await tool.execute("tool-call", {
      action: "insert",
      table: "lumina_memory",
      rows: { kind: "memory", text: "remember me" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/lumina_memory?");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ kind: "memory", text: "remember me" }));
    expect(result.details).toMatchObject({ ok: true, action: "insert", table: "lumina_memory" });
  });

  it("still requires confirm for deletes", async () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const tool = createSupabaseMutateTool({ schema: "public", allowWrites: true });

    const result = await tool.execute("tool-call", {
      action: "delete",
      table: "lumina_memory",
      filters: [{ column: "id", op: "eq", value: 1 }],
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: "confirm=true is required for Supabase delete",
    });
  });
});
