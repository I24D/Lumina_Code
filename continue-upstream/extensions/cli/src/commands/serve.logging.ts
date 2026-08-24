import chalk from "chalk";

import { runtimeEventBus } from "../api/runtimeEvents.js";

export function announceServeReady(
  sessionId: string,
  port: number,
  timeoutSeconds: number,
): void {
  runtimeEventBus.publish("runtime.ready", { sessionId, port });
  console.log(chalk.green(`Server started on http://localhost:${port}`));
  console.log(chalk.dim("Endpoints:"));
  console.log(chalk.dim("  GET  /api/v1/health       - Runtime health"));
  console.log(chalk.dim("  GET  /api/v1/openapi.json - API contract"));
  console.log(chalk.dim("  GET  /api/v1/events       - Runtime event stream"));
  console.log(chalk.dim("  GET  /state                - Current agent state"));
  console.log(
    chalk.dim("  POST /message              - Queue { message: string }"),
  );
  console.log(
    chalk.dim("  POST /permission           - Resolve { requestId, approved }"),
  );
  console.log(chalk.dim("  POST /pause                - Pause current run"));
  console.log(
    chalk.dim("  GET  /diff                 - Git diff against main"),
  );
  console.log(chalk.dim("  POST /exit                 - Graceful shutdown"));
  console.log(
    chalk.dim(
      `\nServer will shut down after ${timeoutSeconds} seconds of inactivity`,
    ),
  );
}
