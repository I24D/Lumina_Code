/**
 * watcher.ts
 * Background service: File system watcher
 *
 * Watches configured directories and logs change events so I24D
 * can react to file system activity in real time.
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";

export type WatcherConfig = {
  paths: string[];
  enabled: boolean;
};

type FsEvent = {
  event: "change" | "rename";
  path: string;
  filename: string | null;
  ts: string;
};

export function createWatcherService(config: WatcherConfig): OpenClawPluginService {
  const watchers: fs.FSWatcher[] = [];
  let ctx: OpenClawPluginServiceContext | null = null;

  function onEvent(watchedPath: string, event: "rename" | "change", filename: string | null) {
    if (!ctx) return;
    const evt: FsEvent = {
      event,
      path: watchedPath,
      filename: filename ? path.join(watchedPath, filename) : null,
      ts: new Date().toISOString(),
    };
    ctx.logger.info(
      `[lumina-watcher] ${event.toUpperCase()} in ${watchedPath}${filename ? ` → ${filename}` : ""}`,
    );
    // In a full implementation this would emit a gateway event so I24D gets notified
    void evt;
  }

  return {
    id: "lumina-pc-watcher",

    async start(context) {
      ctx = context;
      if (!config.enabled || config.paths.length === 0) {
        ctx.logger.debug("[lumina-watcher] No paths configured — watcher inactive.");
        return;
      }

      for (const watchPath of config.paths) {
        try {
          const watcher = fs.watch(
            watchPath,
            { recursive: false },
            (event, filename) => onEvent(watchPath, event, filename),
          );
          watcher.on("error", (err) => {
            ctx?.logger.warn(`[lumina-watcher] Error watching ${watchPath}: ${err.message}`);
          });
          watchers.push(watcher);
          ctx.logger.info(`[lumina-watcher] Watching: ${watchPath}`);
        } catch (err) {
          ctx.logger.warn(
            `[lumina-watcher] Cannot watch ${watchPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    async stop() {
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      watchers.length = 0;
      ctx?.logger.info("[lumina-watcher] Stopped.");
      ctx = null;
    },
  };
}
