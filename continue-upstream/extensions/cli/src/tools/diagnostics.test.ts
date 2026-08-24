import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { diagnosticsTool } from "./diagnostics.js";

describe("Diagnostics tool", () => {
  it("returns an actionable message for unsupported file types", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "lumina-diagnostics-tool-"),
    );
    const filepath = path.join(directory, "README.md");
    fs.writeFileSync(filepath, "# test", "utf8");
    try {
      await expect(diagnosticsTool.run({ filepath })).resolves.toContain(
        "No portable LSP is configured for .md",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
