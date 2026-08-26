import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: { workspaceFolders: [] },
  window: {},
  commands: {},
  Uri: {},
}));

import {
  compareVersions,
  sanitizeBackupValue,
  validateBackupDocument,
} from "./runtimeMaintenance";

describe("runtime maintenance safety", () => {
  it("removes secret fields and redacts credential-shaped strings", () => {
    expect(
      sanitizeBackupValue({
        model: "kimi-k3:cloud",
        apiKey: "must-not-leave",
        note: "Authorization: Bearer abc.def.ghi",
      }),
    ).toEqual({
      model: "kimi-k3:cloud",
      note: "Authorization: Bearer [REDACTED]",
    });
  });

  it("compares release versions numerically", () => {
    expect(compareVersions("1.3.43", "v1.4.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.0")).toBe(1);
    expect(compareVersions("1.3.43", "1.3.43")).toBe(0);
  });

  it("rejects workspace traversal in a restore document", () => {
    expect(() =>
      validateBackupDocument({
        schema: "lumina-code-backup",
        version: 1,
        createdAt: "2026-08-25T00:00:00.000Z",
        extensionVersion: "1.3.43",
        secretsExcluded: true,
        auditExcluded: true,
        globalState: {},
        persistentFiles: [],
        workspaceFiles: [
          {
            workspaceIndex: 0,
            workspaceName: "workspace",
            relativePath: ".continue/skills/../../../outside.md",
            content: "blocked",
          },
        ],
      }),
    ).toThrow(/rutas o entradas no permitidas/u);
  });
});
