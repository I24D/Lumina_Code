import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  encodeLspMessage,
  LspMessageParser,
  PortableLspManager,
  PORTABLE_LSP_SERVERS,
  selectPortableLspServer,
} from "./PortableLspManager.js";

function commandExists(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where.exe" : "which", [
      command,
    ]);
    execFileSync(command, ["--version"], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

describe("PortableLspManager", () => {
  it("selects a server by file extension", () => {
    expect(selectPortableLspServer(path.join("src", "main.ts"))?.id).toBe(
      "typescript",
    );
    expect(selectPortableLspServer("main.rs")?.id).toBe("rust-analyzer");
    expect(selectPortableLspServer("README.md")).toBeUndefined();
  });

  it("parses fragmented and consecutive LSP frames", () => {
    const parser = new LspMessageParser();
    const first = encodeLspMessage({ id: 1, result: { ok: true } });
    const second = encodeLspMessage({
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///test.ts", diagnostics: [] },
    });
    expect(parser.push(first.subarray(0, 9))).toEqual([]);
    expect(parser.push(Buffer.concat([first.subarray(9), second]))).toEqual([
      { id: 1, result: { ok: true } },
      {
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///test.ts", diagnostics: [] },
      },
    ]);
  });

  it("initializes a stdio server and collects published diagnostics", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "lumina-lsp-fake-"),
    );
    const filepath = path.join(directory, "source.fake");
    fs.writeFileSync(filepath, "test", "utf8");
    const fixture = fileURLToPath(
      new URL("./fixtures/fakeLspServer.cjs", import.meta.url),
    );
    const manager = new PortableLspManager([
      {
        id: "fake",
        command: process.execPath,
        args: [fixture],
        versionArgs: ["--version"],
        extensions: [".fake"],
        languageId: "fake",
        installHint: "none",
      },
    ]);
    try {
      const result = await manager.getDiagnostics(filepath, 5000);
      expect(result).toMatchObject({
        serverId: "fake",
        timedOut: false,
        diagnostics: [{ source: "fake-lsp", message: "Synthetic diagnostic" }],
      });
    } finally {
      await manager.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!commandExists("rust-analyzer"))(
    "collects real diagnostics from an installed stdio language server",
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-lsp-"));
      const filepath = path.join(directory, "main.rs");
      fs.writeFileSync(filepath, "fn main( {\n", "utf8");
      const rust = PORTABLE_LSP_SERVERS.find(
        (definition) => definition.id === "rust-analyzer",
      )!;
      const manager = new PortableLspManager([rust]);
      try {
        const result = await manager.getDiagnostics(filepath, 15_000);
        expect(result.serverId).toBe("rust-analyzer");
        expect(result.timedOut).toBe(false);
        expect(result.diagnostics.length).toBeGreaterThan(0);
      } finally {
        await manager.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
