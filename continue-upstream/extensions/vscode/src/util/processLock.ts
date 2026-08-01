import * as fs from "node:fs";
import * as path from "node:path";

export type ProcessLock = {
  filepath: string;
  ownerPid: number;
};

type ProcessLockOptions = {
  initializationGraceMs?: number;
  ownerPid?: number;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function tryAcquireProcessLock(
  filepath: string,
  options: ProcessLockOptions = {},
): ProcessLock | undefined {
  const ownerPid = options.ownerPid ?? process.pid;
  const initializationGraceMs = options.initializationGraceMs ?? 10_000;
  fs.mkdirSync(path.dirname(filepath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(filepath, "wx");
      try {
        fs.writeFileSync(handle, String(ownerPid), "utf8");
      } finally {
        fs.closeSync(handle);
      }
      return { filepath, ownerPid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      let existingOwnerPid = 0;
      try {
        existingOwnerPid = Number.parseInt(
          fs.readFileSync(filepath, "utf8").trim(),
          10,
        );
      } catch {
        // Another process may still be initializing the lock file.
      }
      if (Number.isInteger(existingOwnerPid) && existingOwnerPid > 0) {
        if (isProcessAlive(existingOwnerPid)) {
          return undefined;
        }
      } else {
        try {
          const ageMs = Date.now() - fs.statSync(filepath).mtimeMs;
          if (ageMs < initializationGraceMs) {
            return undefined;
          }
        } catch {
          continue;
        }
      }

      try {
        fs.unlinkSync(filepath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function releaseProcessLock(lock: ProcessLock | undefined): void {
  if (!lock) {
    return;
  }

  try {
    const existingOwnerPid = Number.parseInt(
      fs.readFileSync(lock.filepath, "utf8").trim(),
      10,
    );
    if (existingOwnerPid === lock.ownerPid) {
      fs.unlinkSync(lock.filepath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
