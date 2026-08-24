import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceEnvValue } from "./workspaceEnv.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWorkspaceEnvValue", () => {
  it("prefers the process environment", () => {
    expect(
      resolveWorkspaceEnvValue([], ["TOKEN", "FALLBACK"], {
        TOKEN: "from-process",
      }),
    ).toBe("from-process");
  });

  it("walks up from a workspace without mutating process.env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-env-"));
    tempDirs.push(root);
    const nested = path.join(root, "repo", "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "I24D_GITHUB=test-token\n");

    expect(
      resolveWorkspaceEnvValue([nested], ["GITHUB_TOKEN", "I24D_GITHUB"], {}),
    ).toBe("test-token");
  });
});
