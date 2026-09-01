import { clearGoal, getGoal, listGoals, setGoal } from "../goals/goalStore.js";
import {
  applyVerdict,
  createGoal,
  parseGoalVerdict,
} from "../goals/sessionGoal.js";
import { GitHubWorkItemService } from "../integrations/GitHubWorkItemService.js";
import {
  CAPABILITIES,
  getPermissions,
  resetPermissions,
  setPermission,
} from "../privacy/permissions.js";
import { resolveWorkspaceEnvValue } from "../util/workspaceEnv.js";
import { defineHandlers } from "./types.js";

export default defineHandlers("privacy", (ctx) => {
  const { on } = ctx;

  on("privacy/getPermissions", async () => ({
    capabilities: CAPABILITIES,
    permissions: getPermissions(),
  }));

  on("privacy/setPermission", async (msg) => {
    const permissions = setPermission(msg.data.capability, msg.data.policy);
    ctx.securityAudit.record({
      category: "permissions",
      action: "permission_changed",
      actor: "user",
      outcome: "changed",
      summary: `${msg.data.capability} cambió a ${permissions[msg.data.capability] ?? "ask"}.`,
      details: {
        capability: msg.data.capability,
        policy: permissions[msg.data.capability] ?? "ask",
      },
    });
    return permissions;
  });

  on("privacy/resetPermissions", async () => {
    const permissions = resetPermissions();
    ctx.securityAudit.record({
      category: "permissions",
      action: "permissions_reset",
      actor: "user",
      outcome: "changed",
      summary: "Se restablecieron los permisos predeterminados.",
    });
    return permissions;
  });

  on("security/audit/list", async (msg) => ctx.securityAudit.list(msg.data));
  on("security/audit/record", async (msg) => {
    ctx.securityAudit.record(msg.data);
  });
  on("security/audit/clear", async () => ({
    removed: ctx.securityAudit.clear(),
  }));

  on("channels/get", async () => ctx.channelService.get());
  on("channels/update", async (msg) => {
    const snapshot = ctx.channelService.update(msg.data.id, msg.data.patch);
    ctx.securityAudit.record({
      category: "channels",
      action: "channel_policy_changed",
      actor: "user",
      outcome: "changed",
      summary: `Cambió la política de ${msg.data.id}.`,
      details: {
        channel: msg.data.id,
        enabled:
          snapshot.channels.find((item) => item.id === msg.data.id)?.enabled ??
          false,
        mode:
          snapshot.channels.find((item) => item.id === msg.data.id)?.mode ??
          "manual",
      },
    });
    ctx.core.refreshWhatsAppSuggestionMonitor();
    return snapshot;
  });

  on("goals/get", async (msg) => getGoal(msg.data.sessionId));

  on("goals/list", async () => listGoals());

  on("goals/set", async (msg) =>
    setGoal(createGoal(msg.data.sessionId, msg.data.text, msg.data.maxTurns)),
  );

  // El juicio del turno lo hace el cliente con el modelo de chat; aquí solo
  // se parsea de forma defensiva y se aplica el techo de turnos, que es la
  // parte que no puede quedar en manos de la respuesta de un modelo.
  on("goals/applyVerdict", async (msg) => {
    const goal = getGoal(msg.data.sessionId);
    if (!goal) {
      return undefined;
    }
    return setGoal(applyVerdict(goal, parseGoalVerdict(msg.data.raw)));
  });

  on("goals/clear", async (msg) => {
    clearGoal(msg.data.sessionId);
  });

  on("github/getWorkItem", async (msg) => {
    const workspaceDirs = await ctx.ide.getWorkspaceDirs();
    const token = resolveWorkspaceEnvValue(workspaceDirs, [
      "GITHUB_TOKEN",
      "I24D_GITHUB",
      "LUMINA_PC_GITHUB_TOKEN",
    ]);
    return new GitHubWorkItemService(token).get(msg.data.reference);
  });
});
