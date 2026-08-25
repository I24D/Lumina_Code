import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillUsageStore, STALE_AFTER_DAYS } from "./SkillUsageStore";

let dir: string;
let store: SkillUsageStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-skill-usage-"));
  store = new SkillUsageStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function usageFile(): string {
  return path.join(dir, ".usage.json");
}

/** Rewrites a record's timestamps to simulate the passage of time. */
function backdate(name: string, daysAgo: number): void {
  const raw = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
  const stamp = new Date(
    Date.now() - daysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
  raw[name].createdAt = stamp;
  if (raw[name].lastUsedAt) {
    raw[name].lastUsedAt = stamp;
  }
  fs.writeFileSync(usageFile(), JSON.stringify(raw), "utf8");
}

describe("SkillUsageStore", () => {
  it("reports nothing before anything has been recorded", () => {
    expect(store.viewAll()).toEqual([]);
    expect(store.get("anything")).toBeUndefined();
  });

  it("counts each use and remembers when the last one happened", () => {
    store.recordUse("Deploy");
    store.recordUse("Deploy");

    const view = store.get("Deploy");
    expect(view?.useCount).toBe(2);
    expect(view?.lastUsedAt).toBeDefined();
    expect(view?.state).toBe("active");
  });

  it("separates skills Lumina wrote from skills the user wrote", () => {
    store.recordCreate("Learned", "agent");
    store.recordUse("HandWritten");

    expect(store.get("Learned")?.createdBy).toBe("agent");
    // A skill first seen through use was not authored by the agent, so it must
    // not be credited to it — that provenance decides what can be auto-archived.
    expect(store.get("HandWritten")?.createdBy).toBe("user");
  });

  it("counts an overwrite as the skill improving itself", () => {
    store.recordCreate("Deploy", "agent");
    store.recordPatch("Deploy");

    const view = store.get("Deploy");
    expect(view?.patchCount).toBe(1);
    expect(view?.lastPatchedAt).toBeDefined();
  });

  describe("staleness", () => {
    it("flags an agent skill left untouched past the threshold", () => {
      store.recordCreate("Forgotten", "agent");
      backdate("Forgotten", STALE_AFTER_DAYS + 1);

      expect(store.get("Forgotten")?.state).toBe("stale");
    });

    it("leaves an agent skill active just inside the threshold", () => {
      store.recordCreate("Recent", "agent");
      backdate("Recent", STALE_AFTER_DAYS - 1);

      expect(store.get("Recent")?.state).toBe("active");
    });

    it("never flags a pinned skill", () => {
      store.recordCreate("Pinned", "agent");
      store.setPinned("Pinned", true);
      backdate("Pinned", STALE_AFTER_DAYS * 10);

      expect(store.get("Pinned")?.state).toBe("active");
    });

    it("never flags a hand-written skill", () => {
      // The user chose to write it. Quiet stretches are not a verdict on it.
      store.recordUse("HandWritten");
      backdate("HandWritten", STALE_AFTER_DAYS * 10);

      expect(store.get("HandWritten")?.state).toBe("active");
    });
  });

  describe("archiving", () => {
    it("hides a skill without touching its counters", () => {
      store.recordUse("Old");
      store.setArchived("Old", true);

      expect(store.get("Old")?.state).toBe("archived");
      expect(store.get("Old")?.useCount).toBe(1);
    });

    it("restores a skill the moment it is used again", () => {
      store.recordUse("Old");
      store.setArchived("Old", true);
      store.recordUse("Old");

      // Reaching for it is the evidence that archiving it was wrong.
      expect(store.get("Old")?.state).toBe("active");
    });

    it("restores a skill that gets rewritten", () => {
      store.recordCreate("Old", "agent");
      store.setArchived("Old", true);
      store.recordPatch("Old");

      expect(store.get("Old")?.state).toBe("active");
    });
  });

  it("forgets a skill's telemetry on request", () => {
    store.recordUse("Gone");
    store.forget("Gone");

    expect(store.get("Gone")).toBeUndefined();
  });

  describe("resilience", () => {
    it("treats a corrupt usage file as empty rather than throwing", () => {
      fs.writeFileSync(usageFile(), "{not json", "utf8");

      expect(store.viewAll()).toEqual([]);
      // And it must recover: the next write rebuilds the file.
      store.recordUse("After");
      expect(store.get("After")?.useCount).toBe(1);
    });

    it("repairs individual entries with impossible values", () => {
      fs.writeFileSync(
        usageFile(),
        JSON.stringify({
          Broken: { useCount: "many", patchCount: -3, createdBy: "aliens" },
        }),
        "utf8",
      );

      const view = store.get("Broken");
      // NaN counters would poison every comparison that ranks the skill index.
      expect(view?.useCount).toBe(0);
      expect(view?.patchCount).toBe(0);
      expect(view?.createdBy).toBe("user");
    });

    it("creates the skills directory when writing the first record", () => {
      const missing = path.join(dir, "does", "not", "exist");
      new SkillUsageStore(missing).recordUse("First");

      expect(fs.existsSync(path.join(missing, ".usage.json"))).toBe(true);
    });
  });
});
