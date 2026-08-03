/**
 * system-metrics.ts
 * Tool: lumina_system_metrics
 *
 * Reports real-time CPU, RAM, disk and network state to I24D.
 * Uses built-in Node.js `os` module — no extra dependencies.
 */

import os from "node:os";
import { Type } from "typebox";
import { jsonResult } from "../openclaw-sdk.js";
import type { AnyAgentTool } from "../openclaw-sdk.js";

function cpuUsagePercent(): Promise<number> {
  return new Promise((resolve) => {
    const start = os.cpus().map((c) => ({ ...c.times }));
    setTimeout(() => {
      const end = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;
      for (let i = 0; i < end.length; i++) {
        const s = start[i];
        const e = end[i]?.times;
        if (!s || !e) continue;
        const idleDiff = e.idle - s.idle;
        const totalDiff =
          e.user + e.nice + e.sys + e.idle + e.irq - (s.user + s.nice + s.sys + s.idle + s.irq);
        totalIdle += idleDiff;
        totalTick += totalDiff;
      }
      const usage = totalTick === 0 ? 0 : 100 - (100 * totalIdle) / totalTick;
      resolve(Math.round(usage * 10) / 10);
    }, 500);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function createSystemMetricsTool(): AnyAgentTool {
  return {
    name: "lumina_system_metrics",
    description:
      "Returns real-time system metrics for the local Windows PC: CPU usage %, total/free RAM, uptime, platform info, and network interfaces. Call this to let I24D know the current health of the machine.",
    parameters: Type.Object({
      include_network: Type.Optional(
        Type.Boolean({
          description: "Include network interface details (default: false).",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      const includeNetwork = params.include_network === true;

      const [cpuPct, totalMem, freeMem, uptime, platform, hostname, arch, cpus] = await Promise.all(
        [
          cpuUsagePercent(),
          Promise.resolve(os.totalmem()),
          Promise.resolve(os.freemem()),
          Promise.resolve(os.uptime()),
          Promise.resolve(os.platform()),
          Promise.resolve(os.hostname()),
          Promise.resolve(os.arch()),
          Promise.resolve(os.cpus()),
        ],
      );

      const usedMem = totalMem - freeMem;
      const memPct = Math.round((usedMem / totalMem) * 1000) / 10;

      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);

      const metrics: Record<string, unknown> = {
        cpu: {
          usage_pct: cpuPct,
          cores: cpus.length,
          model: cpus[0]?.model ?? "unknown",
          speed_mhz: cpus[0]?.speed ?? 0,
        },
        memory: {
          total: formatBytes(totalMem),
          used: formatBytes(usedMem),
          free: formatBytes(freeMem),
          usage_pct: memPct,
          total_bytes: totalMem,
          free_bytes: freeMem,
        },
        system: {
          platform,
          hostname,
          arch,
          uptime_seconds: uptime,
          uptime_human: `${hours}h ${minutes}m`,
          node_version: process.version,
        },
        timestamp: new Date().toISOString(),
      };

      if (includeNetwork) {
        const nets = os.networkInterfaces();
        const netSummary: Record<string, unknown[]> = {};
        for (const [name, addrs] of Object.entries(nets)) {
          netSummary[name] = (addrs ?? []).map((a) => ({
            address: a.address,
            family: a.family,
            internal: a.internal,
          }));
        }
        metrics.network = netSummary;
      }

      return jsonResult(metrics);
    },
  };
}
