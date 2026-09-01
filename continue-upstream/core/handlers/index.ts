import autocomplete from "./autocomplete.js";
import config from "./config.js";
import context from "./context.js";
import docs from "./docs.js";
import edit from "./edit.js";
import files from "./files.js";
import indexing from "./indexing.js";
import memory from "./memory.js";
import privacy from "./privacy.js";
import scheduler from "./scheduler.js";
import session from "./session.js";
import startTalk from "./startTalk.js";
import tools from "./tools.js";
import type { CoreHandlerModule } from "./types.js";

/**
 * Every group of core message handlers, in registration order.
 *
 * Registration is data rather than 1,300 lines of imperative `on(...)` calls:
 * `Core` loops over this list, so adding a group means adding a file and one
 * line here, and no two features have to edit the same function to ship.
 */
export const CORE_HANDLER_MODULES: readonly CoreHandlerModule[] = [
  session,
  memory,
  config,
  context,
  autocomplete,
  edit,
  startTalk,
  privacy,
  scheduler,
  indexing,
  files,
  docs,
  tools,
];

export * from "./types.js";
