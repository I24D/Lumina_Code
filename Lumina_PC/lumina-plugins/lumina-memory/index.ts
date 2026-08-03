/**
 * Lumina Memory — Phase 2 (Structured Long-Term Memory)
 * ════════════════════════════════════════════════════════════════
 * Three tiers:
 *   1. UserProfile (single JSON document, slow-changing)
 *   2. FactStore (append-only JSONL, fast-changing)
 *   3. Working memory is the agent's context window — not managed here.
 *
 * Recall backend:
 *   - BM25 over the FactStore by default (zero dependencies, deterministic)
 *   - mem0 via HTTP if `mem0BaseUrl` is configured (opt-in, NOT silent
 *     fallback — if mem0 fails, the tool returns an error)
 *
 * Disabled by default. Opt-in via `plugins.entries.lumina-memory.enabled`.
 * ════════════════════════════════════════════════════════════════
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { FactStore } from "./src/storage/fact-store.js";
import { ProfileStore } from "./src/storage/profile-store.js";
import { RecallEngine } from "./src/recall/recall-engine.js";
import { createMemoryRecallTool } from "./src/tools/recall.js";
import { createMemoryRememberTool } from "./src/tools/remember.js";
import { createProfileReadTool } from "./src/tools/profile-read.js";
import { createProfileUpdateTool } from "./src/tools/profile-update.js";

type LuminaMemoryConfig = {
  enabled?: boolean;
  profileDir?: string;
  factStoreDir?: string;
  mem0BaseUrl?: string;
  mem0ApiKey?: string;
  recallLimitDefault?: number;
};

export default definePluginEntry({
  id: "lumina-memory",
  name: "Lumina Memory",
  description:
    "Structured long-term memory: user profile, fact store with append-only JSONL, BM25 recall by default, optional mem0 backend. Four tools: lumina_memory_recall, lumina_memory_remember, lumina_memory_profile_read, lumina_memory_profile_update.",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as LuminaMemoryConfig;
    if (raw.enabled === false) return;

    const profile = new ProfileStore({ profileDir: raw.profileDir });
    const facts = new FactStore({ factStoreDir: raw.factStoreDir });
    const recall = new RecallEngine(facts, {
      mem0BaseUrl: raw.mem0BaseUrl,
      mem0ApiKey: raw.mem0ApiKey,
      recallLimitDefault: raw.recallLimitDefault ?? 8,
    });

    api.registerTool(createMemoryRecallTool(recall, raw.recallLimitDefault ?? 8));
    api.registerTool(createMemoryRememberTool(facts));
    api.registerTool(createProfileReadTool(profile));
    api.registerTool(createProfileUpdateTool(profile));
  },
});
