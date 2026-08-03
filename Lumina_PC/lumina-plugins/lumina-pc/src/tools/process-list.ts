/**
 * process-list.ts
 * Tool: lumina_process_list
 *
 * Lists running processes on the Windows PC via PowerShell.
 * Allows I24D to observe what the user has open and detect anomalies.
 */

import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";
import { canRunPowerShell, psEscape, runPowerShell } from "../utils/powershell.js";
import { bridgeGet, isWindowsBridgeMode } from "../utils/windows-bridge.js";

export function createProcessListTool(): AnyAgentTool {
  return {
    name: "lumina_process_list",
    description:
      "Lists running processes on the Windows PC with name, PID, CPU and memory usage. " +
      "Optionally filter by name. Use this for I24D to monitor what is running or to find a specific process.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description:
            "Filter processes by name (partial match, case-insensitive). Leave empty for all.",
        }),
      ),
      top: Type.Optional(
        Type.Number({
          description: "Return only the top N processes sorted by CPU usage. Default: 50.",
          minimum: 1,
          maximum: 500,
        }),
      ),
      sort_by: Type.Optional(
        Type.Union([Type.Literal("cpu"), Type.Literal("memory"), Type.Literal("name")], {
          description: "Sort by cpu | memory | name. Default: cpu.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (isWindowsBridgeMode()) {
        const response = await bridgeGet("/processes");
        if (response.ok !== true) {
          return jsonResult({ ok: false, error: response.error ?? "windows_bridge_failed" });
        }
        let processes = Array.isArray(response.processes) ? response.processes : [];
        const filter = params.filter?.trim().toLowerCase();
        if (filter) {
          processes = processes.filter((item) =>
            String((item as Record<string, unknown>).ProcessName ?? "")
              .toLowerCase()
              .includes(filter),
          );
        }
        const sortBy = params.sort_by ?? "cpu";
        processes = processes.sort((a, b) => {
          const left = a as Record<string, unknown>;
          const right = b as Record<string, unknown>;
          if (sortBy === "name") {
            return String(left.ProcessName ?? "").localeCompare(String(right.ProcessName ?? ""));
          }
          const key = sortBy === "memory" ? "WorkingSet64" : "CPU";
          return Number(right[key] ?? 0) - Number(left[key] ?? 0);
        });
        const top = Math.min(params.top ?? 50, 500);
        processes = processes.slice(0, top).map((item) => {
          const row = item as Record<string, unknown>;
          return {
            ProcessName: row.ProcessName,
            Id: row.Id,
            CPU: row.CPU,
            MemoryMB: Math.round((Number(row.WorkingSet64 ?? 0) / 1024 / 1024) * 10) / 10,
            MainWindowTitle: row.MainWindowTitle,
          };
        });
        return jsonResult({
          ok: true,
          via: "lumina-windows-bridge",
          count: processes.length,
          sort_by: sortBy,
          filter: params.filter ?? null,
          processes,
          timestamp: new Date().toISOString(),
        });
      }

      if (!canRunPowerShell()) {
        return jsonResult({
          ok: false,
          error: "lumina_process_list needs Windows or WSL (powershell.exe over interop).",
        });
      }

      const top = Math.min(params.top ?? 50, 500);
      const sortBy = params.sort_by ?? "cpu";
      const sortProp =
        sortBy === "memory" ? "WorkingSet64" : sortBy === "name" ? "ProcessName" : "CPU";
      const sortDir = sortBy === "name" ? "-Ascending" : "-Descending";

      const filterClause = params.filter?.trim()
        ? `| Where-Object { $_.ProcessName -like "*${psEscape(params.filter.trim())}*" } `
        : "";

      const psCmd =
        `Get-Process ${filterClause}` +
        `| Sort-Object ${sortProp} ${sortDir} ` +
        `| Select-Object -First ${top} ` +
        `| Select-Object ProcessName, Id, CPU, ` +
        `@{N='MemoryMB';E={[Math]::Round($_.WorkingSet64/1MB,1)}}, ` +
        `@{N='Status';E={$_.Responding}} ` +
        `| ConvertTo-Json -Compress`;

      const result = await runPowerShell(psCmd, 15_000);

      if (!result.ok) {
        return jsonResult({ ok: false, error: result.error ?? result.stderr });
      }

      let processes: unknown[] = [];
      try {
        const parsed = JSON.parse(result.stdout);
        processes = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        processes = [];
      }

      return jsonResult({
        ok: true,
        count: processes.length,
        sort_by: sortBy,
        filter: params.filter ?? null,
        processes,
        timestamp: new Date().toISOString(),
      });
    },
  };
}
