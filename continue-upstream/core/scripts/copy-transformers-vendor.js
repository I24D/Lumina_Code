import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const coreRoot = path.resolve(path.dirname(scriptPath), "..");
const sourcePath = path.join(
  coreRoot,
  "node_modules",
  "@xenova",
  "transformers",
);
const destinationPath = path.join(
  coreRoot,
  "vendor",
  "modules",
  "@xenova",
  "transformers",
);
const lockPath = path.join(
  coreRoot,
  "vendor",
  "modules",
  "@xenova",
  ".transformers-vendor.lock",
);
const requiredEntryPoint = path.join("src", "transformers.js");
const LOCK_TIMEOUT_MS = 120_000;
const STALE_LOCK_MS = 5 * 60_000;

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireVendorLock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      wait(100);
    }
  }

  throw new Error(
    `Timed out waiting for another Transformers.js vendor preparation at ${lockPath}.`,
  );
}

export function copyTransformersVendor() {
  const sourceEntryPoint = path.join(sourcePath, requiredEntryPoint);
  if (!fs.existsSync(sourceEntryPoint)) {
    throw new Error(
      `Transformers.js dependency was not found at ${sourceEntryPoint}. Install core dependencies before preparing the vendor directory.`,
    );
  }

  const lockHandle = acquireVendorLock();
  const stagingPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, stagingPath, {
      recursive: true,
      force: true,
      dereference: true,
    });

    const stagingEntryPoint = path.join(stagingPath, requiredEntryPoint);
    if (!fs.existsSync(stagingEntryPoint)) {
      throw new Error(
        `Transformers.js vendor entry point was not created at ${stagingEntryPoint}.`,
      );
    }

    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.renameSync(stagingPath, destinationPath);
    console.log(
      `[info] Prepared Transformers.js vendor package at ${destinationPath}`,
    );
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.closeSync(lockHandle);
    fs.rmSync(lockPath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    copyTransformersVendor();
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
  }
}
