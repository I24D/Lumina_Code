import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IDE } from "../..";
import { localPathToUri } from "../../util/pathToUri";
import {
  clearMarkdownSkillCache,
  loadMarkdownSkills,
} from "./loadMarkdownSkills";

const SKILL_URI = "file:///ws/.claude/skills/demo/SKILL.md";
const SKILL_BODY = `---
name: demo
description: A demo skill used to check the load cache.
---

## When to Use

When testing.
`;

/**
 * A workspace with exactly one skill. `readFile` and `getFileStats` are spies so
 * the test can assert how often the loader actually touches disk.
 */
function makeIde(lastModified: number) {
  const readFile = vi.fn(async (uri: string) => {
    if (uri === SKILL_URI) {
      return SKILL_BODY;
    }
    throw new Error(`unexpected readFile: ${uri}`);
  });

  const getFileStats = vi.fn(async (files: string[]) =>
    Object.fromEntries(
      files.map((f) => [f, { size: SKILL_BODY.length, lastModified }]),
    ),
  );

  const ide = {
    getWorkspaceDirs: async () => ["file:///ws"],
    fileExists: async (uri: string) =>
      uri === "file:///ws/.claude/skills" || uri === SKILL_URI,
    listDir: async (dir: string) => {
      if (dir === "file:///ws/.claude/skills") {
        return [["demo", 2]] as [string, number][];
      }
      if (dir === "file:///ws/.claude/skills/demo") {
        return [["SKILL.md", 1]] as [string, number][];
      }
      return [] as [string, number][];
    },
    readFile,
    getFileStats,
  } as unknown as IDE;

  return { ide, readFile, getFileStats };
}

describe("loadMarkdownSkills caching", () => {
  beforeEach(() => {
    clearMarkdownSkillCache();
  });

  it("finds the skill and reads it once on a cold cache", async () => {
    const { ide, readFile } = makeIde(1000);

    const { skills, errors } = await loadMarkdownSkills(ide);

    expect(errors).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["demo"]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does not re-read an unchanged skill on the next load", async () => {
    const { ide, readFile } = makeIde(1000);

    await loadMarkdownSkills(ide);
    const afterFirst = readFile.mock.calls.length;
    const { skills } = await loadMarkdownSkills(ide);

    expect(afterFirst).toBe(1);
    expect(readFile).toHaveBeenCalledTimes(1); // second load served from cache
    expect(skills.map((s) => s.name)).toEqual(["demo"]);
  });

  it("re-reads when the file's mtime moves", async () => {
    const first = makeIde(1000);
    await loadMarkdownSkills(first.ide);
    expect(first.readFile).toHaveBeenCalledTimes(1);

    // Same URI, newer mtime: the cached parse must not be trusted.
    const second = makeIde(2000);
    const { skills } = await loadMarkdownSkills(second.ide);

    expect(second.readFile).toHaveBeenCalledTimes(1);
    expect(skills.map((s) => s.name)).toEqual(["demo"]);
  });

  it("still loads when the IDE cannot supply stats", async () => {
    const { ide, getFileStats, readFile } = makeIde(1000);
    getFileStats.mockRejectedValue(new Error("not supported"));

    const a = await loadMarkdownSkills(ide);
    const b = await loadMarkdownSkills(ide);

    expect(a.skills.map((s) => s.name)).toEqual(["demo"]);
    expect(b.skills.map((s) => s.name)).toEqual(["demo"]);
    // No stats means no caching, but never a lost skill.
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

const BUNDLED_DIR =
  process.platform === "win32" ? "C:\\ext\\skills" : "/ext/skills";
const BUNDLED_DIR_URI = localPathToUri(BUNDLED_DIR);
const BUNDLED_SKILL_URI = `${BUNDLED_DIR_URI}/demo/SKILL.md`;
const BUNDLED_BODY = `---
name: demo
description: The copy that ships inside the VSIX.
---

## When to Use

When the workspace has none of its own.
`;

/**
 * A machine where the bundled library exists outside every workspace directory,
 * optionally with a workspace skill of the same name to shadow it.
 */
function makeBundledIde(opts: { withWorkspaceSkill: boolean }) {
  const readFile = vi.fn(async (uri: string) => {
    if (uri === SKILL_URI) {
      return SKILL_BODY;
    }
    if (uri === BUNDLED_SKILL_URI) {
      return BUNDLED_BODY;
    }
    throw new Error(`unexpected readFile: ${uri}`);
  });

  const dirs = new Map<string, [string, number][]>([
    [BUNDLED_DIR_URI, [["demo", 2]]],
    [`${BUNDLED_DIR_URI}/demo`, [["SKILL.md", 1]]],
  ]);
  if (opts.withWorkspaceSkill) {
    dirs.set("file:///ws/.claude/skills", [["demo", 2]]);
    dirs.set("file:///ws/.claude/skills/demo", [["SKILL.md", 1]]);
  }

  const ide = {
    getWorkspaceDirs: async () => ["file:///ws"],
    fileExists: async (uri: string) =>
      dirs.has(uri) || uri === SKILL_URI || uri === BUNDLED_SKILL_URI,
    listDir: async (dir: string) => dirs.get(dir) ?? ([] as [string, number][]),
    readFile,
    getFileStats: async (files: string[]) =>
      Object.fromEntries(
        files.map((f) => [f, { size: 1, lastModified: 1 }]),
      ),
  } as unknown as IDE;

  return { ide, readFile };
}

describe("skills that ship inside the extension", () => {
  const previous = process.env.LUMINA_BUNDLED_SKILLS_DIR;

  beforeEach(() => {
    clearMarkdownSkillCache();
    process.env.LUMINA_BUNDLED_SKILLS_DIR = BUNDLED_DIR;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.LUMINA_BUNDLED_SKILLS_DIR;
    } else {
      process.env.LUMINA_BUNDLED_SKILLS_DIR = previous;
    }
  });

  it("loads a library that lives outside every workspace", async () => {
    const { ide } = makeBundledIde({ withWorkspaceSkill: false });

    const { skills, errors } = await loadMarkdownSkills(ide);

    // The whole point: no workspace folder, no home folder, still a library.
    expect(errors).toEqual([]);
    expect(skills.map((s) => s.description)).toEqual([
      "The copy that ships inside the VSIX.",
    ]);
  });

  it("loads nothing extra when the host never set the directory", async () => {
    delete process.env.LUMINA_BUNDLED_SKILLS_DIR;
    const { ide } = makeBundledIde({ withWorkspaceSkill: false });

    const { skills } = await loadMarkdownSkills(ide);

    expect(skills).toEqual([]);
  });

  it("lets a workspace skill shadow the bundled one of the same name", async () => {
    const { ide } = makeBundledIde({ withWorkspaceSkill: true });

    const { skills } = await loadMarkdownSkills(ide);

    // `read_skill` resolves a name to the first match, so a duplicate name
    // would decide by accident. One entry survives, and it is the user's.
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe(
      "A demo skill used to check the load cache.",
    );
  });
});
