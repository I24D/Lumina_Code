import { stringifyMcpPrompt } from "../commands/slash/mcpSlashCommand";
import { createNewAssistantFile } from "../config/createNewAssistantFile";
import {
  isColocatedRulesFile,
  isContinueConfigRelatedUri,
} from "../config/loadLocalAssistants";
import { CodebaseRulesCache } from "../config/markdown/loadCodebaseRules";
import { addModel, deleteModel } from "../config/util";
import {
  createNewGlobalRuleFile,
  createNewWorkspaceBlockFile,
} from "../config/workspace/workspaceBlocks";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import { performAuth, removeMCPAuth } from "../context/mcp/MCPOauth";
import { DataLogger } from "../data/log";
import { walkDirCache } from "../indexing/walkDir";
import { createNewPromptFileV2 } from "../promptFiles/createNewPromptFile";
import { defineHandlers } from "./types.js";

export default defineHandlers("config", (ctx) => {
  const { on } = ctx;

  on("devdata/log", async (msg) => {
    void DataLogger.getInstance().logDevData(msg.data);
  });

  on("config/addModel", async (msg) => {
    const model = msg.data.model;
    const { config } = await ctx.configHandler.loadConfig();
    const allModels = Object.values(config?.modelsByRole ?? {}).flat();
    const existing = allModels.find(
      (m) => m.providerName === model.provider && m.model === model.model,
    );
    if (existing) {
      void ctx.ide.showToast(
        "warning",
        "Model already exists in config. Update the API key in the config file.",
      );
      await ctx.configHandler.openConfigProfile();
      return;
    }
    addModel(model, msg.data.role);
    void ctx.configHandler.reloadConfig(
      "Model added (config/addModel message)",
    );
  });

  on("config/deleteModel", (msg) => {
    deleteModel(msg.data.title);
    void ctx.configHandler.reloadConfig(
      "Model removed (config/deleteModel message)",
    );
  });

  on("config/newPromptFile", async (msg) => {
    const { config } = await ctx.configHandler.loadConfig();
    await createNewPromptFileV2(ctx.ide, config?.experimental?.promptPath);
    await ctx.configHandler.reloadConfig(
      "Prompt file created (config/newPromptFile message)",
    );
  });

  on("config/newAssistantFile", async (msg) => {
    await createNewAssistantFile(ctx.ide, undefined);
    await ctx.configHandler.refreshAll(
      "Assistant file created (config/newAssistantFile message)",
    );
  });

  on("config/addLocalWorkspaceBlock", async (msg) => {
    await createNewWorkspaceBlockFile(
      ctx.ide,
      msg.data.blockType,
      msg.data.baseFilename,
    );
    walkDirCache.invalidate();
    await ctx.configHandler.reloadConfig(
      "Local block created (config/addLocalWorkspaceBlock message)",
    );
  });

  on("config/addGlobalRule", async (msg) => {
    try {
      await createNewGlobalRuleFile(ctx.ide, msg.data?.baseFilename);
      walkDirCache.invalidate();
      await ctx.configHandler.reloadConfig(
        "Global rule created (config/addGlobalRule message)",
      );
    } catch (error) {
      throw error;
    }
  });

  on("config/deleteRule", async (msg) => {
    try {
      const filepath = msg.data.filepath;
      if (
        !isColocatedRulesFile(filepath) &&
        !isContinueConfigRelatedUri(filepath)
      ) {
        throw new Error("Only rule files can be deleted");
      }
      const fileExists = await ctx.ide.fileExists(filepath);
      if (fileExists) {
        await ctx.ide.removeFile(filepath);
        walkDirCache.invalidate();
        await ctx.configHandler.reloadConfig(
          "Rule file deleted (config/deleteRule message)",
        );
      }
    } catch (error) {
      console.error("Failed to delete rule file:", error);
      throw error;
    }
  });

  on("config/openProfile", async (msg) => {
    await ctx.configHandler.openConfigProfile(msg.data.profileId);
  });

  on("config/ideSettingsUpdate", async (msg) => {
    await ctx.configHandler.updateIdeSettings(msg.data);
  });

  on("config/refreshProfiles", async (msg) => {
    // User force reloading will retrigger colocated rules
    const codebaseRulesCache = CodebaseRulesCache.getInstance();
    await codebaseRulesCache.refresh(ctx.ide);

    const { selectProfileId, reason } = msg.data ?? {};
    await ctx.configHandler.refreshAll(reason);
    if (selectProfileId) {
      await ctx.configHandler.setSelectedProfileId(selectProfileId);
    }
  });

  on("config/updateSharedConfig", async (msg) => {
    const newSharedConfig = ctx.globalContext.updateSharedConfig(msg.data);
    await ctx.configHandler.reloadConfig(
      "Shared config update (config/updateSharedConfig message)",
    );
    return newSharedConfig;
  });

  on("config/updateSelectedModel", async (msg) => {
    const newSelectedModels = ctx.globalContext.updateSelectedModel(
      msg.data.profileId,
      msg.data.role,
      msg.data.title,
    );
    await ctx.configHandler.reloadConfig(
      "Selected model update (config/updateSelectedModel message)",
    );
    return newSelectedModels;
  });

  on("mcp/reloadServer", async (msg) => {
    await MCPManagerSingleton.getInstance().refreshConnection(msg.data.id);
  });
  on("mcp/setServerEnabled", async (msg) => {
    const { id, enabled } = msg.data;
    await MCPManagerSingleton.getInstance().setEnabled(id, enabled);
  });
  on("mcp/getPrompt", async (msg) => {
    const { serverName, promptName, args } = msg.data;
    const prompt = await MCPManagerSingleton.getInstance().getPrompt(
      serverName,
      promptName,
      args,
    );
    const stringifiedPrompt = stringifyMcpPrompt(prompt);
    return {
      prompt: stringifiedPrompt,
      description: prompt.description,
    };
  });
  on("mcp/startAuthentication", async (msg) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    MCPManagerSingleton.getInstance().setStatus(
      msg.data.serverId,
      "authenticating",
    );
    const status = await performAuth(
      msg.data.serverId,
      msg.data.serverUrl,
      ctx.ide,
    );
    if (status === "AUTHORIZED") {
      await MCPManagerSingleton.getInstance().refreshConnection(
        msg.data.serverId,
      );
    }
  });
  on("mcp/removeAuthentication", async (msg) => {
    removeMCPAuth(msg.data.serverUrl, ctx.ide);
    await MCPManagerSingleton.getInstance().refreshConnection(
      msg.data.serverId,
    );
  });
});
