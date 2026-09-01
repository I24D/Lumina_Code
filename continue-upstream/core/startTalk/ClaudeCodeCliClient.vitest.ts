import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeCliClient } from "./ClaudeCodeCliClient";

const ORIGINAL_CLI = process.env.LUMINA_CLAUDE_CLI;

afterEach(() => {
  if (ORIGINAL_CLI === undefined) {
    delete process.env.LUMINA_CLAUDE_CLI;
  } else {
    process.env.LUMINA_CLAUDE_CLI = ORIGINAL_CLI;
  }
});

describe("ClaudeCodeCliClient.resolveCliPath", () => {
  it("prefers an explicitly injected path over the environment", () => {
    process.env.LUMINA_CLAUDE_CLI = "C:\\from-env\\claude.cmd";
    const client = new ClaudeCodeCliClient({
      cliPath: "C:\\injected\\claude.cmd",
    });

    expect(client.resolveCliPath()).toBe("C:\\injected\\claude.cmd");
  });

  it("honours LUMINA_CLAUDE_CLI when no path is injected", () => {
    process.env.LUMINA_CLAUDE_CLI = "C:\\from-env\\claude.cmd";

    expect(new ClaudeCodeCliClient().resolveCliPath()).toBe(
      "C:\\from-env\\claude.cmd",
    );
  });

  it("ignores a blank LUMINA_CLAUDE_CLI", () => {
    process.env.LUMINA_CLAUDE_CLI = "   ";

    // Falls through to discovery; on a machine without a local install that
    // lands on PATH, which is the documented last resort.
    expect(new ClaudeCodeCliClient().resolveCliPath()).not.toBe("   ");
  });
});

describe("ClaudeCodeCliClient.generateReply", () => {
  it("returns null instead of throwing when the CLI cannot be spawned", async () => {
    const client = new ClaudeCodeCliClient({
      cliPath: "C:\\definitely\\not\\a\\real\\claude-binary.cmd",
      timeoutMs: 5_000,
      logger: () => {},
    });

    const reply = await client.generateReply({
      system: "persona",
      user: "hola",
    });

    // The auto-responder audits a null; a thrown error would kill the monitor.
    expect(reply).toBeNull();
  });
});
