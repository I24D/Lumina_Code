import { IDE } from "../index.js";
import { joinPathsToUri } from "../util/uri.js";

import { ProjectFiles } from "./types.js";

/**
 * Adapts the IDE to the two calls detection needs, rooted at one workspace
 * directory.
 *
 * Reads are cached per path for the life of the adapter because the detectors
 * probe the same manifests repeatedly — package.json is read once and then
 * asked about again by every lockfile check — and each probe is an IPC round
 * trip to the editor.
 */
export function workspaceFiles(ide: IDE, workspaceDir: string): ProjectFiles {
  const reads = new Map<string, Promise<string | undefined>>();

  const readOnce = (relativePath: string) => {
    const cached = reads.get(relativePath);
    if (cached) {
      return cached;
    }
    const uri = joinPathsToUri(workspaceDir, relativePath);
    const pending = ide
      .fileExists(uri)
      .then((exists) => (exists ? ide.readFile(uri) : undefined))
      // A file that cannot be read is, for detection purposes, absent.
      .catch(() => undefined);
    reads.set(relativePath, pending);
    return pending;
  };

  return {
    async exists(relativePath) {
      return (await readOnce(relativePath)) !== undefined;
    },
    async read(relativePath) {
      return await readOnce(relativePath);
    },
  };
}
