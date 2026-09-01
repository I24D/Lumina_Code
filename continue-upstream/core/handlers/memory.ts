import { PluginCatalogService } from "../config/PluginCatalogService.js";
import { getSessionSearchIndex } from "../learning/SessionSearchIndex.js";
import { getSkillUsageStore } from "../learning/SkillUsageStore.js";
import { SkillWorkshopService } from "../learning/SkillWorkshopService.js";
import {
  getMemorySyncStatus,
  type SupabaseMemoryConfig,
  SupabaseMemorySync,
} from "../memory/SupabaseMemorySync.js";
import { luminaAgentRuntime } from "../orchestrator/index.js";
import { getTodoStore } from "../planner/TodoStore.js";
import { type MemoryOverview } from "../protocol/core";
import { resolveWorkspaceEnvValue } from "../util/workspaceEnv.js";
import { detectRecipe } from "../verify/detectRecipe.js";
import { workspaceFiles } from "../verify/workspaceFiles.js";
import { defineHandlers } from "./types.js";

/**
 * Everything Lumina remembers: procedural memory (skills, plugins), the working
 * task list, the workboard, and the episodic memory synced to Supabase.
 */
export default defineHandlers("memory", (ctx) => {
  const { on } = ctx;
  const skillWorkshop = new SkillWorkshopService(ctx.ide);
  const pluginCatalog = new PluginCatalogService(ctx.ide);

  const resolveMemoryConfig = async (): Promise<SupabaseMemoryConfig> => {
    const dirs = await ctx.ide.getWorkspaceDirs();
    return {
      url: resolveWorkspaceEnvValue(dirs, ["LUMINA_SUPABASE_URL"]),
      publishableKey: resolveWorkspaceEnvValue(dirs, [
        "LUMINA_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
      ]),
      accessToken: resolveWorkspaceEnvValue(dirs, [
        "LUMINA_SUPABASE_ACCESS_TOKEN",
      ]),
      table: resolveWorkspaceEnvValue(dirs, ["LUMINA_SUPABASE_MEMORY_TABLE"]),
      namespace: resolveWorkspaceEnvValue(dirs, [
        "LUMINA_SUPABASE_MEMORY_NAMESPACE",
      ]),
    };
  };

  const memoryOverview = async (
    query?: string,
    limit?: number,
  ): Promise<MemoryOverview> => {
    const current = ctx.core.getMemorySyncStatus();
    const configuredStatus = getMemorySyncStatus(await resolveMemoryConfig());
    if (
      configuredStatus.provider !== current.provider ||
      configuredStatus.configured !== current.configured
    ) {
      ctx.core.setMemorySyncStatus(configuredStatus);
    }
    return {
      snapshot: luminaAgentRuntime.getMemorySnapshot(),
      matches: query?.trim()
        ? luminaAgentRuntime.searchMemory(query, limit)
        : [],
      sync: ctx.core.getMemorySyncStatus(),
    };
  };

  // Memory — procedural (skills) and episodic (past sessions)
  on("skills/list", async () => {
    return await ctx.core.listSkillsWithUsage();
  });

  on("skills/curate", async (msg) => {
    const store = getSkillUsageStore();
    const { name, action } = msg.data;
    switch (action) {
      case "archive":
        store.setArchived(name, true);
        break;
      case "unarchive":
        store.setArchived(name, false);
        break;
      case "pin":
        store.setPinned(name, true);
        break;
      case "unpin":
        store.setPinned(name, false);
        break;
    }
    // Returning the fresh list saves the settings page a second round trip
    // and guarantees it renders what was actually persisted.
    return await ctx.core.listSkillsWithUsage();
  });

  on("skills/workshop/lint", async (msg) => skillWorkshop.lint(msg.data));

  on("skills/workshop/save", async (msg) => {
    const saved = await skillWorkshop.save(msg.data.draft, {
      overwrite: msg.data.overwrite,
      provenance: "user",
    });
    await ctx.configHandler.reloadConfig("Skill saved from workshop");
    return { saved, skills: await ctx.core.listSkillsWithUsage() };
  });

  on("plugins/list", async () => pluginCatalog.list());

  on("plugins/setEnabled", async (msg) => {
    const plugins = await pluginCatalog.setEnabled(
      msg.data.id,
      msg.data.enabled,
    );
    await ctx.configHandler.reloadConfig("Plugin catalog changed");
    return plugins;
  });

  on("todos/list", async () => {
    return getTodoStore().read();
  });

  on("memory/get", async (msg) =>
    memoryOverview(msg.data?.query, msg.data?.limit),
  );

  on("memory/delete", async (msg) => {
    luminaAgentRuntime.deleteMemory(msg.data.id);
    return memoryOverview();
  });

  on("memory/clear", async () => {
    luminaAgentRuntime.clearMemory();
    return memoryOverview();
  });

  on("memory/sync", async () => {
    const config = await resolveMemoryConfig();
    const status = getMemorySyncStatus(config);
    if (!status.configured) {
      ctx.core.setMemorySyncStatus(status);
      return memoryOverview();
    }
    ctx.core.setMemorySyncStatus({ ...status, state: "syncing" });
    try {
      const snapshot = await new SupabaseMemorySync(config).sync(
        luminaAgentRuntime.getMemorySnapshot(),
      );
      luminaAgentRuntime.replaceMemory(snapshot);
      ctx.core.setMemorySyncStatus({
        ...status,
        state: "synced",
        lastSyncAt: new Date().toISOString(),
      });
    } catch (error) {
      ctx.core.setMemorySyncStatus({
        ...status,
        state: "error",
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    return memoryOverview();
  });

  on("workboard/get", async () => ctx.workboardService.snapshot());

  on("workboard/create", async (msg) => ctx.workboardService.create(msg.data));

  on("workboard/update", async (msg) =>
    ctx.workboardService.update(msg.data.id, msg.data.patch),
  );

  on("workboard/delete", async (msg) => {
    ctx.workboardService.remove(msg.data.id);
  });

  on("verify/recipe", async () => {
    const dirs = await ctx.ide.getWorkspaceDirs();
    if (dirs.length === 0) {
      return undefined;
    }
    return await detectRecipe(workspaceFiles(ctx.ide, dirs[0]));
  });

  on("sessions/search", async (msg) => {
    const index = getSessionSearchIndex();
    const { query, limit, currentWorkspaceOnly } = msg.data;

    let workspaceDirectory: string | undefined;
    if (currentWorkspaceOnly) {
      workspaceDirectory = (await ctx.ide.getWorkspaceDirs())[0];
    }

    try {
      await index.refresh();
    } catch {
      // Stale results beat no results; the index is still queryable.
    }

    if (!query || query.trim() === "") {
      return {
        hits: [],
        recent: await index.browse(limit ?? 20, workspaceDirectory),
      };
    }
    return {
      hits: await index.search({
        query: query.trim(),
        limit,
        workspaceDirectory,
      }),
      recent: [],
    };
  });
});
