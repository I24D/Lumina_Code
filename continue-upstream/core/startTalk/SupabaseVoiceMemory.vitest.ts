import { describe, expect, it, vi } from "vitest";

import {
  SupabaseVoiceMemory,
  type SupabaseVoiceMemoryConfig,
  type VoiceTranscriptEntry,
} from "./SupabaseVoiceMemory.js";

const CONFIG: SupabaseVoiceMemoryConfig = {
  url: "https://project.supabase.co",
  serviceRoleKey: "service-role-key",
  openAiApiKey: "openai-key",
  embeddingModel: "text-embedding-3-small",
  summaryModel: "gpt-4o-mini",
  voiceUserId: "lumina-user:owner",
  wikiUserId: "lumina",
};

/** Un `fetch` de mentira que responde por ruta y registra lo enviado. */
function fakeFetch(
  routes: Array<{ match: RegExp; json?: unknown; ok?: boolean }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => r.match.test(url));
    const ok = route?.ok ?? true;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => route?.json ?? [],
      text: async () => "",
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("loadMemoryBlock", () => {
  it("combines profile, durable memories and recent conversation", async () => {
    const { impl } = fakeFetch([
      {
        match: /user_profiles/,
        json: [{ facts: ["Nació en Oaxaca"], interests: ["ciberseguridad"] }],
      },
      {
        match: /long_term_memories\?user_id/,
        json: [
          { summary: "Prefiere respuestas breves", created_at: "2026-08-01" },
        ],
      },
      {
        match: /conversations/,
        json: [
          {
            messages: [
              { role: "user", text: "hola" },
              { role: "assistant", text: "hola, ¿en qué te ayudo?" },
            ],
          },
        ],
      },
    ]);
    const memory = new SupabaseVoiceMemory(CONFIG, { fetch: impl });

    const block = await memory.loadMemoryBlock();

    expect(block).toContain("Nació en Oaxaca");
    expect(block).toContain("Prefiere respuestas breves");
    expect(block).toContain("User: hola");
    // Nunca debe leerse en voz alta ni anunciar que tiene memoria.
    expect(block).toContain("never read it aloud verbatim");
  });

  it("returns an empty block when there is nothing stored", async () => {
    const { impl } = fakeFetch([{ match: /./, json: [] }]);
    const memory = new SupabaseVoiceMemory(CONFIG, { fetch: impl });

    expect(await memory.loadMemoryBlock()).toBe("");
  });

  it("degrades to an empty block instead of throwing when Supabase fails", async () => {
    const { impl } = fakeFetch([{ match: /./, ok: false }]);
    const memory = new SupabaseVoiceMemory(CONFIG, { fetch: impl });

    expect(await memory.loadMemoryBlock()).toBe("");
  });
});

describe("recall", () => {
  it("merges the three sources and ranks by similarity", async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0.01));
    const { impl, calls } = fakeFetch([
      {
        match: /rpc\/match_long_term_memories/,
        json: [{ summary: "Le gusta el café", similarity: 0.7 }],
      },
      {
        match: /rpc\/match_memory_wiki/,
        json: [
          {
            title: "Dal Nijaruq",
            summary: "Creador de Lumina",
            similarity: 0.9,
          },
        ],
      },
      {
        match: /rpc\/match_knowledge/,
        json: [
          {
            question: "Privesc Windows",
            answer: '{"answer":"whoami /priv y tokens"}',
            similarity: 0.6,
          },
        ],
      },
    ]);
    const memory = new SupabaseVoiceMemory(CONFIG, { fetch: impl, embed });

    const recall = await memory.recall("quién es el usuario");

    expect(recall.hits.map((h) => h.kind)).toEqual([
      "wiki",
      "memory",
      "knowledge",
    ]);
    // La respuesta de conocimiento venía como JSON {answer}; se extrae el texto.
    expect(recall.hits[2].text).toContain("whoami /priv");
    // El embedding se manda a las RPC como literal de vector de pgvector.
    const rpcCall = calls.find((c) => /rpc\/match_knowledge/.test(c.url));
    const body = JSON.parse(String(rpcCall?.init?.body));
    expect(body.query_embedding.startsWith("[")).toBe(true);
  });

  it("returns no hits for an empty query without touching the network", async () => {
    const embed = vi.fn();
    const { impl, calls } = fakeFetch([{ match: /./, json: [] }]);
    const memory = new SupabaseVoiceMemory(CONFIG, { fetch: impl, embed });

    const recall = await memory.recall("   ");

    expect(recall.hits).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("learn", () => {
  const transcript: VoiceTranscriptEntry[] = [
    { role: "user", text: "recuerda que trabajo de noche" },
    { role: "assistant", text: "lo tendré presente" },
  ];

  it("stores the thread and a durable, embedded fact", async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0.02));
    const summarize = vi.fn(async () => "El usuario trabaja de noche.");
    const { impl, calls } = fakeFetch([{ match: /./, json: [] }]);
    const memory = new SupabaseVoiceMemory(CONFIG, {
      fetch: impl,
      embed,
      summarize,
    });

    await memory.learn(transcript);

    const insert = calls.find((c) => /long_term_memories/.test(c.url));
    expect(insert).toBeDefined();
    const body = JSON.parse(String(insert?.init?.body));
    expect(body.user_id).toBe("lumina-user:owner");
    expect(body.summary).toBe("El usuario trabaja de noche.");
    expect(body.embedding.startsWith("[")).toBe(true);
    expect(body.message_count).toBe(2);
    // Y el hilo se guardó en conversations con upsert por user_id.
    expect(
      calls.some((c) => /conversations\?on_conflict=user_id/.test(c.url)),
    ).toBe(true);
  });

  it("skips a conversation too short to learn from", async () => {
    const embed = vi.fn();
    const { impl, calls } = fakeFetch([{ match: /./, json: [] }]);
    const memory = new SupabaseVoiceMemory(CONFIG, { fetch: impl, embed });

    await memory.learn([{ role: "user", text: "hola" }]);

    expect(calls).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it("saves the thread but no durable fact when there is nothing durable", async () => {
    const embed = vi.fn(async () => new Array(1536).fill(0.02));
    // Resumen demasiado corto para ser un hecho durable útil.
    const summarize = vi.fn(async () => "");
    const { impl, calls } = fakeFetch([{ match: /./, json: [] }]);
    const memory = new SupabaseVoiceMemory(CONFIG, {
      fetch: impl,
      embed,
      summarize,
    });

    await memory.learn(transcript);

    // El hilo se guarda igual, pero no se inserta memoria durable ni se vectoriza.
    expect(calls.some((c) => /conversations/.test(c.url))).toBe(true);
    expect(calls.some((c) => /long_term_memories/.test(c.url))).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });
});
