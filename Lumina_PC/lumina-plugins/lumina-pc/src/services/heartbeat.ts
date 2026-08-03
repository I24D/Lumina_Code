/**
 * heartbeat.ts
 * Background service: Lumina_PC system heartbeat
 *
 * Runs at a configurable interval and publishes system metrics
 * as a diagnostic event so I24D always knows the health of the machine.
 *
 * The heartbeat also watches for critical conditions (low RAM, high CPU)
 * and fires reflex alerts automatically.
 */

import os from "node:os";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";

export type HeartbeatConfig = {
  intervalMs: number;
  enabled: boolean;
};

type SystemSnapshot = {
  ts: string;
  cpu_pct: number;
  mem_used_pct: number;
  mem_free_mb: number;
  uptime_s: number;
  platform: string;
};

function cpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = os.cpus().map((c) => ({ ...c.times }));
    setTimeout(() => {
      const t1 = os.cpus();
      let idle = 0;
      let total = 0;
      for (let i = 0; i < t1.length; i++) {
        const a = t0[i];
        const b = t1[i]?.times;
        if (!a || !b) continue;
        idle += b.idle - a.idle;
        total +=
          b.user + b.nice + b.sys + b.idle + b.irq -
          (a.user + a.nice + a.sys + a.idle + a.irq);
      }
      resolve(total === 0 ? 0 : Math.round((100 - (100 * idle) / total) * 10) / 10);
    }, 300);
  });
}

function snapshot(): Promise<SystemSnapshot> {
  return cpuUsage().then((cpu) => {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      ts: new Date().toISOString(),
      cpu_pct: cpu,
      mem_used_pct: Math.round(((total - free) / total) * 1000) / 10,
      mem_free_mb: Math.round(free / 1024 / 1024),
      uptime_s: Math.floor(os.uptime()),
      platform: os.platform(),
    };
  });
}

export function createHeartbeatService(config: HeartbeatConfig): OpenClawPluginService {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ctx: OpenClawPluginServiceContext | null = null;

  const tick = async () => {
    const currentCtx = ctx;
    if (!currentCtx) return;
    try {
      const snap = await snapshot();

      // Log to gateway diagnostics so I24D can observe metrics
      currentCtx.logger.debug(
        `[lumina-heartbeat] CPU=${snap.cpu_pct}% MEM=${snap.mem_used_pct}% FREE=${snap.mem_free_mb}MB UP=${snap.uptime_s}s`,
      );

      // Critical alerts → notify via logger (in production, emit a gateway event)
      if (snap.cpu_pct > 90) {
        currentCtx.logger.warn(`[lumina-heartbeat] HIGH CPU: ${snap.cpu_pct}% — I24D should investigate.`);
      }
      if (snap.mem_free_mb < 256) {
        currentCtx.logger.warn(
          `[lumina-heartbeat] LOW MEMORY: only ${snap.mem_free_mb} MB free — I24D should investigate.`,
        );
      }
    } catch (err) {
      currentCtx.logger.error(`[lumina-heartbeat] tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    id: "lumina-pc-heartbeat",

    async start(context) {
      if (!config.enabled) return;
      ctx = context;
      ctx.logger.info(
        `[lumina-heartbeat] Starting — interval ${config.intervalMs}ms on ${os.platform()} (${os.hostname()})`,
      );
      await tick(); // immediate first tick
      timer = setInterval(() => void tick(), config.intervalMs);
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      ctx?.logger.info("[lumina-heartbeat] Stopped.");
      ctx = null;
    },
  };
}
