import { defineHandlers } from "./types.js";

export default defineHandlers("scheduler", (ctx) => {
  const { on } = ctx;

  on("scheduler/list", async () => ctx.scheduledTaskService.list());
  on("scheduler/create", async (msg) =>
    ctx.scheduledTaskService.create(msg.data),
  );
  on("scheduler/update", async (msg) =>
    ctx.scheduledTaskService.update(msg.data.id, msg.data.patch),
  );
  on("scheduler/delete", async (msg) => {
    ctx.scheduledTaskService.remove(msg.data.id);
  });
  on("scheduler/runNow", async (msg) =>
    ctx.scheduledTaskService.runNow(msg.data.id),
  );
  on("scheduler/claimDue", async () => ctx.scheduledTaskService.claimDue());
  on("scheduler/reportRun", async (msg) => {
    ctx.scheduledTaskService.reportRun(msg.data);
  });
});
