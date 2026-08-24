import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentWorkingDirectory,
  runWithAgentExecutionContext,
} from "../stream/executionContext.js";

import { runTerminalCommandTool } from "./runTerminalCommand.js";
import { writeFileTool } from "./writeFile.js";

describe("request-scoped tool working directory", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps relative file and terminal operations inside the child workspace", async () => {
    const worktree = fs.mkdtempSync(
      path.join(os.tmpdir(), "lumina-agent-cwd-"),
    );
    temporaryDirectories.push(worktree);

    await runWithAgentExecutionContext(
      {
        sessionId: "child",
        kind: "subagent",
        workingDirectory: worktree,
      },
      async () => {
        const preprocessed = await writeFileTool.preprocess!({
          filepath: "nested/file.txt",
          content: "isolated",
        });
        await writeFileTool.run(preprocessed.args);
        expect(
          fs.readFileSync(path.join(worktree, "nested", "file.txt"), "utf8"),
        ).toBe("isolated");

        expect(getAgentWorkingDirectory()).toBe(worktree);
        const command =
          process.platform === "win32" ? "(Get-Location).Path" : "pwd";
        const output = await runTerminalCommandTool.run({ command });
        expect(path.resolve(output.trim())).toBe(path.resolve(worktree));
      },
    );
  });
});
