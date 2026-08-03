/**
 * Tests for the agentskills.io loader.
 *
 * Covers: spec compliance (valid + invalid frontmatter cases from
 * https://agentskills.io/specification), hot reload, asset listing,
 * path traversal protection in readAsset().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoader } from "./skill-loader.js";

let tmpDir = "";

function writeSkill(folder: string, body: string): string {
  const dir = path.join(tmpDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-skills-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("SkillLoader — spec compliance", () => {
  it("loads a minimal valid skill", () => {
    writeSkill(
      "roll-dice",
      [
        "---",
        "name: roll-dice",
        "description: Roll dice using a random number generator. Use when asked to roll a die.",
        "---",
        "",
        "To roll a die, compute RANDOM % sides + 1.",
      ].join("\n"),
    );
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const list = loader.list();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe("roll-dice");
    const skill = loader.get("roll-dice")!;
    expect(skill).toBeTruthy();
    expect(skill.instructions).toContain("RANDOM % sides");
    expect(skill.errors).toBeUndefined();
    expect(loader.errors()).toEqual([]);
  });

  it("loads optional fields license, compatibility, metadata, allowed-tools", () => {
    writeSkill(
      "pdf-processing",
      [
        "---",
        "name: pdf-processing",
        "description: Extract PDF text, fill forms, merge files.",
        "license: Apache-2.0",
        "compatibility: Requires Python 3.14+ and uv",
        "allowed-tools: Bash(git:*) Bash(jq:*) Read",
        "metadata:",
        "  author: example-org",
        "  version: \"1.0\"",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    const skill = new SkillLoader({ skillsDir: tmpDir }).get("pdf-processing")!;
    expect(skill.license).toBe("Apache-2.0");
    expect(skill.compatibility).toBe("Requires Python 3.14+ and uv");
    expect(skill.allowedTools).toEqual(["Bash(git:*)", "Bash(jq:*)", "Read"]);
    expect(skill.metadata.author).toBe("example-org");
    expect(skill.metadata.version).toBe("1.0");
  });

  it("rejects name with uppercase, leading/trailing or consecutive hyphens", () => {
    writeSkill(
      "PDF-Processing",
      "---\nname: PDF-Processing\ndescription: x\n---",
    );
    writeSkill(
      "leading-hyphen",
      "---\nname: -leading\ndescription: x\n---",
    );
    writeSkill(
      "double--hyphen",
      "---\nname: double--hyphen\ndescription: x\n---",
    );
    const loader = new SkillLoader({ skillsDir: tmpDir });
    expect(loader.list().length).toBe(0);
    expect(loader.errors().length).toBeGreaterThanOrEqual(3);
    for (const err of loader.errors()) {
      expect(err.error).toMatch(/name/i);
    }
  });

  it("rejects skill whose `name` doesn't match the folder", () => {
    writeSkill(
      "actual-folder",
      "---\nname: different-name\ndescription: x\n---",
    );
    const loader = new SkillLoader({ skillsDir: tmpDir });
    expect(loader.list().length).toBe(0);
    expect(loader.errors()[0]!.error).toMatch(/must match the parent folder name/);
  });

  it("rejects missing required fields", () => {
    writeSkill("no-name", "---\ndescription: x\n---");
    writeSkill("no-desc", "---\nname: no-desc\n---");
    writeSkill("empty-desc", "---\nname: empty-desc\ndescription: \n---");
    const loader = new SkillLoader({ skillsDir: tmpDir });
    expect(loader.list().length).toBe(0);
    expect(loader.errors().length).toBe(3);
  });

  it("rejects description > 1024 chars", () => {
    const big = "x".repeat(1025);
    writeSkill("big-desc", `---\nname: big-desc\ndescription: ${big}\n---`);
    const loader = new SkillLoader({ skillsDir: tmpDir });
    expect(loader.list().length).toBe(0);
    expect(loader.errors()[0]!.error).toMatch(/1024/);
  });

  it("ignores directories without SKILL.md", () => {
    fs.mkdirSync(path.join(tmpDir, "not-a-skill"));
    fs.writeFileSync(path.join(tmpDir, "not-a-skill", "README.md"), "hi");
    const loader = new SkillLoader({ skillsDir: tmpDir });
    expect(loader.list().length).toBe(0);
    expect(loader.errors().length).toBe(0);
  });

  it("returns empty list when skillsDir does not exist", () => {
    const loader = new SkillLoader({ skillsDir: path.join(tmpDir, "missing") });
    expect(loader.list()).toEqual([]);
    expect(loader.errors()).toEqual([]);
  });
});

describe("SkillLoader — real-world tolerance", () => {
  it("accepts flow-style JSON metadata (used by many real skills)", () => {
    writeSkill(
      "flow-meta",
      [
        "---",
        "name: flow-meta",
        "description: Uses JSON-as-YAML for metadata.",
        "metadata:",
        '  {',
        '    "openclaw": { "emoji": "🛠️" },',
        '    "version": "1.0",',
        '  }',
        "---",
        "body",
      ].join("\n"),
    );
    const skill = new SkillLoader({ skillsDir: tmpDir }).get("flow-meta")!;
    expect(skill).toBeTruthy();
    expect(skill.metadata.version).toBe("1.0");
    expect((skill.metadata.openclaw as { emoji: string }).emoji).toBe("🛠️");
  });

  it("folds unknown top-level frontmatter fields into metadata", () => {
    writeSkill(
      "extra-fields",
      [
        "---",
        "name: extra-fields",
        "description: Has a homepage field outside the spec.",
        "homepage: https://example.com",
        "---",
        "body",
      ].join("\n"),
    );
    const skill = new SkillLoader({ skillsDir: tmpDir }).get("extra-fields")!;
    expect(skill).toBeTruthy();
    expect(skill.metadata.homepage).toBe("https://example.com");
  });

  it("does not crash on stray indented or malformed top-level lines", () => {
    writeSkill(
      "weird",
      [
        "---",
        "name: weird",
        "description: A skill with messy formatting.",
        "  stray-indent-line",
        "no-colon-line",
        "---",
        "body",
      ].join("\n"),
    );
    const skill = new SkillLoader({ skillsDir: tmpDir }).get("weird")!;
    expect(skill).toBeTruthy();
    expect(skill.description).toContain("messy");
  });
});

describe("SkillLoader — resources", () => {
  it("lists scripts/, references/, assets/ without loading contents", () => {
    writeSkill("with-bundles", "---\nname: with-bundles\ndescription: x\n---\n\nbody");
    const dir = path.join(tmpDir, "with-bundles");
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "scripts", "extract.py"), "print('hi')");
    fs.mkdirSync(path.join(dir, "references"));
    fs.writeFileSync(path.join(dir, "references", "REFERENCE.md"), "details");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "template.txt"), "template");

    const skill = new SkillLoader({ skillsDir: tmpDir }).get("with-bundles")!;
    expect(skill.scripts.map((r) => r.relPath)).toEqual(["scripts/extract.py"]);
    expect(skill.references.map((r) => r.relPath)).toEqual(["references/REFERENCE.md"]);
    expect(skill.assets.map((r) => r.relPath)).toEqual(["assets/template.txt"]);
    expect(skill.scripts[0]!.sizeBytes).toBeGreaterThan(0);
  });
});

describe("SkillLoader — readAsset", () => {
  it("reads a valid relative path", () => {
    writeSkill("read-me", "---\nname: read-me\ndescription: x\n---");
    fs.mkdirSync(path.join(tmpDir, "read-me", "scripts"));
    fs.writeFileSync(path.join(tmpDir, "read-me", "scripts", "hello.py"), "print('hi')");
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const r = loader.readAsset("read-me", "scripts/hello.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("print('hi')");
  });

  it("rejects path traversal", () => {
    writeSkill("safe", "---\nname: safe\ndescription: x\n---");
    fs.writeFileSync(path.join(tmpDir, "outside.txt"), "secret");
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const r = loader.readAsset("safe", "../outside.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/relative and inside/);
  });

  it("rejects absolute path", () => {
    writeSkill("safe2", "---\nname: safe2\ndescription: x\n---");
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const r = loader.readAsset(
      "safe2",
      process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects files over maxBytes", () => {
    writeSkill("limit", "---\nname: limit\ndescription: x\n---");
    fs.writeFileSync(path.join(tmpDir, "limit", "big.bin"), Buffer.alloc(2048));
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const r = loader.readAsset("limit", "big.bin", { maxBytes: 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/maxBytes/);
  });

  it("supports binary (base64) encoding", () => {
    writeSkill("bin", "---\nname: bin\ndescription: x\n---");
    fs.writeFileSync(path.join(tmpDir, "bin", "data.bin"), Buffer.from([0, 1, 2, 255]));
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const r = loader.readAsset("bin", "data.bin", { encoding: "binary" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe(Buffer.from([0, 1, 2, 255]).toString("base64"));
  });

  it("returns clear error when skill not found", () => {
    const loader = new SkillLoader({ skillsDir: tmpDir });
    const r = loader.readAsset("missing", "any.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });
});

describe("SkillLoader — hot reload", () => {
  it("picks up a new skill on reload()", () => {
    const loader = new SkillLoader({ skillsDir: tmpDir, reloadEveryMs: 60_000 });
    expect(loader.list().length).toBe(0);
    writeSkill("late", "---\nname: late\ndescription: x\n---");
    // Without an explicit reload(), cache is still empty until reloadEveryMs.
    expect(loader.list().length).toBe(0);
    loader.reload();
    expect(loader.list().length).toBe(1);
  });

  it("drops a skill that was deleted", () => {
    writeSkill("transient", "---\nname: transient\ndescription: x\n---");
    const loader = new SkillLoader({ skillsDir: tmpDir });
    expect(loader.list().length).toBe(1);
    fs.rmSync(path.join(tmpDir, "transient"), { recursive: true, force: true });
    loader.reload();
    expect(loader.list().length).toBe(0);
  });
});
