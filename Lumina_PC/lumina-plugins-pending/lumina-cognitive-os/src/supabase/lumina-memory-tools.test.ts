import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLuminaMemoryRememberTool,
  createLuminaMemorySearchTool,
  normalizeLuminaMemoryRow,
} from "./lumina-memory-tools.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("Lumina memory tools", () => {
  it("normalizes legacy long-term memories and warehouse records", () => {
    expect(
      normalizeLuminaMemoryRow("long_term_memories", {
        id: "legacy-1",
        user_id: "12523953012",
        summary: "[whatsapp] Q: recuerda esto",
        created_at: "2026-05-01T00:00:00Z",
      }),
    ).toMatchObject({
      table: "long_term_memories",
      warehouseId: "legacy",
      summary: "[whatsapp] Q: recuerda esto",
    });

    expect(
      normalizeLuminaMemoryRow("long_term_memories", {
        id: "ccn-1",
        user_id: "warehouse_codex::typescript",
        summary: JSON.stringify({
          warehouseId: "warehouse_codex",
          partition: "typescript",
          type: "code",
          language: "typescript",
          payload: "const answer = 42;",
          meta: { summary: "TypeScript pattern", tags: ["ts"] },
        }),
        created_at: "2026-05-01T00:00:00Z",
      }),
    ).toMatchObject({
      table: "long_term_memories",
      warehouseId: "warehouse_codex",
      partition: "typescript",
      language: "typescript",
      summary: "TypeScript pattern",
      snippet: "const answer = 42;",
    });
  });

  it("stores OpenClaw learnings in long_term_memories without confirmation", async () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "locm_test", user_id: "lumina_openclaw::fact" }]), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createLuminaMemoryRememberTool({ schema: "public", allowWrites: true });
    const result = await tool.execute("tool-call", {
      kind: "fact",
      text: "Dal wants OpenClaw to use Supabase as durable memory.",
      tags: ["openclaw", "memory"],
      source: "test",
      importance: 5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/long_term_memories?select=");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("lumina_openclaw::fact");
    expect(JSON.stringify(result.details)).not.toContain("test-service-role");
    expect(result.details).toMatchObject({ ok: true, userId: "lumina_openclaw::fact" });
  });

  it("searches Lumina memory tables with a safe high-level interface", async () => {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("long_term_memories")) {
        return new Response(
          JSON.stringify([
            { id: "m1", user_id: "125", summary: "[whatsapp] OpenClaw memory", created_at: "2026-05-01" },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createLuminaMemorySearchTool({ schema: "public", maxRows: 50 });
    const result = await tool.execute("tool-call", {
      query: "OpenClaw memory",
      tables: ["long_term_memories"],
      limitPerTable: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("summary=ilike.*OpenClaw+memory*");
    expect(result.details).toMatchObject({ ok: true, count: 1 });
  });
});
