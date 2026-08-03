/**
 * planner.tool-registry.test.ts — Contract test: KNOWN_TOOLS ↔ real tools registered
 *
 * The action planner (Nivel 4) validates that every `toolName` in a proposed
 * plan is a known Lumina tool. `KNOWN_TOOLS` in `planner.ts` is the source of
 * truth. This test guarantees the set stays in sync with the tools each
 * Lumina extension actually registers.
 *
 * When you add a new tool to any lumina-* extension, register it in
 * KNOWN_TOOLS *at the same commit* — this test will fail otherwise.
 *
 * Scope: only the lumina-* extensions authored by the I24D team
 * (lumina-presence, lumina-memory, lumina-observation, lumina-input-control,
 * lumina-claude-bridge, lumina-pc, lumina-cognitive-os).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_TOOLS } from "./planner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_ROOT = path.resolve(HERE, "..", "..", "..");

const LUMINA_EXTENSIONS = [
  "lumina-presence",
  "lumina-memory",
  "lumina-observation",
  "lumina-input-control",
  "lumina-claude-bridge",
  "lumina-pc",
  "lumina-cognitive-os",
] as const;

/**
 * Walk one Lumina extension's src/ tree and collect every string literal that
 * looks like a tool name declared as `name: "lumina_*"`. We restrict to the
 * `name:` property to avoid false positives (comments, other identifiers).
 */
async function collectDeclaredToolNames(extensionDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const srcDir = path.join(extensionDir, "src");

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const text = readFileSync(full, "utf8");
      // Match declared tool names: `name: "lumina_xyz"` inside object literals.
      const declPattern = /name:\s*"(lumina_[a-z0-9_]+)"/g;
      for (const match of text.matchAll(declPattern)) {
        out.add(match[1]!);
      }
    }
  }

  await walk(srcDir);
  return out;
}

async function collectAllLuminaToolNames(): Promise<Map<string, string>> {
  // toolName → which extension declared it
  const toolOwners = new Map<string, string>();
  for (const ext of LUMINA_EXTENSIONS) {
    const extDir = path.join(EXTENSIONS_ROOT, ext);
    const declared = await collectDeclaredToolNames(extDir);
    for (const name of declared) {
      const existing = toolOwners.get(name);
      if (existing && existing !== ext) {
        // Duplicate registration across extensions — assert-worthy.
        toolOwners.set(name, `${existing}+${ext}`);
      } else {
        toolOwners.set(name, ext);
      }
    }
  }
  return toolOwners;
}

describe("action planner KNOWN_TOOLS contract", () => {
  it("has every declared lumina_* tool from all 7 Lumina extensions", async () => {
    const declared = await collectAllLuminaToolNames();
    // Filter: some `name: "lumina_..."` matches are inline object schemas
    // (parameter objects, sub-fields, etc.) rather than tool declarations.
    // We only care about entries that look like tool root names (no dots or
    // dashes). All valid tool names use lowercase snake_case starting with
    // `lumina_`.
    const missing: string[] = [];
    for (const [tool, owner] of declared.entries()) {
      if (!KNOWN_TOOLS.has(tool)) {
        missing.push(`${tool}  (declared by ${owner})`);
      }
    }
    expect(missing, `Tools declared in a lumina-* extension but missing from planner KNOWN_TOOLS:\n  ${missing.join("\n  ")}`).toHaveLength(0);
  });

  it("does not accept a plan that references a fake tool", () => {
    // Sanity: the validator still rejects unknown tools even after our merge.
    // If this ever passes with a fake name, the KNOWN_TOOLS check is
    // silently permissive somewhere.
    expect(KNOWN_TOOLS.has("lumina_totally_made_up_tool_xyz")).toBe(false);
  });

  it("flags any tool registered by more than one lumina-* extension", async () => {
    const declared = await collectAllLuminaToolNames();
    const duplicates = [...declared.entries()].filter(([, owner]) => owner.includes("+"));
    // Currently `lumina_input_control` is exposed by both `lumina-pc` (as a
    // legacy alias for the input-control routing) and `lumina-input-control`
    // (the canonical owner). Accept that specific overlap for now; anything
    // else is a bug worth investigating.
    const unexpected = duplicates.filter(([name]) => name !== "lumina_input_control");
    expect(unexpected, `Unexpected duplicate tool registrations:\n  ${unexpected.map(([n, o]) => `${n} in ${o}`).join("\n  ")}`).toHaveLength(0);
  });
});
