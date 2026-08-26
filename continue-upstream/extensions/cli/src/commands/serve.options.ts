import { processCommandFlags } from "../flags/flagProcessor.js";

import type { ExtendedCommandOptions } from "./BaseCommandOptions.js";

export interface ServeOptions extends ExtendedCommandOptions {
  timeout?: string;
  port?: string;
  /** Storage identifier for remote sync. */
  id?: string;
}

/** Build the exact service bootstrap contract without starting an HTTP server. */
export function getServeInitializationOptions(options: ServeOptions) {
  const { permissionOverrides } = processCommandFlags(options);
  return {
    options,
    toolPermissionOverrides: permissionOverrides,
    headless: true as const,
  };
}
