import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  releaseProcessLock,
  tryAcquireProcessLock,
} from "./processLock";

const tempRoots: string[] = [];

function createLockPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-process-lock-"));
  tempRoots.push(root);
  return path.join(root, "runtime.lock");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("processLock", () => {
  test("allows only one live owner and can be released", () => {
    const filepath = createLockPath();
    const first = tryAcquireProcessLock(filepath);

    expect(first).toBeDefined();
    expect(tryAcquireProcessLock(filepath)).toBeUndefined();

    releaseProcessLock(first);
    expect(tryAcquireProcessLock(filepath)).toBeDefined();
  });

  test("replaces a lock whose owner is no longer alive", () => {
    const filepath = createLockPath();
    fs.writeFileSync(filepath, "2147483647", "utf8");

    const lock = tryAcquireProcessLock(filepath);

    expect(lock).toBeDefined();
    expect(fs.readFileSync(filepath, "utf8")).toBe(String(process.pid));
  });

  test("does not steal a lock while its owner is being written", () => {
    const filepath = createLockPath();
    fs.writeFileSync(filepath, "", "utf8");

    expect(tryAcquireProcessLock(filepath)).toBeUndefined();
    expect(fs.existsSync(filepath)).toBe(true);
  });
});
