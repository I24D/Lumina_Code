import { config } from "./config.ts";

/**
 * HTTP client for the I24D backend unified-memory API (:3000). Lets Claude, via
 * the gateway, share the SAME long-term memory (Supabase / pgvector) that Start
 * Talk and Lumina Code use — recall past facts and store durable new ones.
 */

export interface MemoryResult {
  ok: boolean;
  status: number;
  data: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function memoryRecall(
  userId: string,
  query: string,
  limit: number,
): Promise<MemoryResult> {
  const url = new URL(`${config.coreUrl}/api/memory/search`);
  url.searchParams.set("userId", userId);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(20_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await readJson(response),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "memory_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function memoryProactive(userId: string): Promise<MemoryResult> {
  const url = new URL(`${config.coreUrl}/api/memory/proactive`);
  url.searchParams.set("userId", userId);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(20_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await readJson(response),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "memory_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function memorySave(
  userId: string,
  memory: string,
): Promise<MemoryResult> {
  try {
    const response = await fetch(`${config.coreUrl}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, memory }),
      signal: AbortSignal.timeout(20_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await readJson(response),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: "memory_unreachable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
