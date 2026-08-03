/**
 * OpenClaw SDK compatibility shim (single indirection point).
 * ────────────────────────────────────────────────────────────────
 * As an EXTERNAL plugin, lumina-pc must not deep-import OpenClaw core
 * internals via a deep relative path into the repo `src/` tree — that only
 * resolves when a plugin lives inside the repo tree. Instead we import
 * from the public plugin SDK subpaths. If a future OpenClaw version
 * relocates one of these symbols, this is the ONLY file to update.
 *
 * Verified against openclaw 2026.7.2:
 *   - jsonResult, AnyAgentTool      → openclaw/plugin-sdk/core
 *   - imageResultFromFile           → openclaw/plugin-sdk/channel-actions
 *   - ToolInputError                → NOT exposed by the public SDK (mirror below)
 */

export { jsonResult } from "openclaw/plugin-sdk/core";
export type { AnyAgentTool } from "openclaw/plugin-sdk/core";
export { imageResultFromFile } from "openclaw/plugin-sdk/channel-actions";

/**
 * Local mirror of the core `ToolInputError`. The public SDK (2026.7.2) does
 * not re-export it, yet the gateway classifies errors with
 * `instanceof ToolInputError` (invalid_input vs internal_error). Because this
 * is a distinct class, input errors thrown from this plugin are reported as
 * `internal_error` rather than `invalid_input`. Functionally correct; the only
 * cost is coarser error classification. Candidate for a 1-line upstream export
 * (`export { ToolInputError } from "../agents/tools/common.js"` in plugin-sdk/core.ts).
 */
export class ToolInputError extends Error {
  readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
