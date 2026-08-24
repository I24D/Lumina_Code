import { describe, expect, it } from "vitest";
import { flattenWalkthrough, parseUnifiedDiff } from "./parseUnifiedDiff";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 123..456 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ function greet() {
 const name = "Lumina";
-console.log(name);
+console.log("Hello", name);
+return name;
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const ready = true;
+export default ready;`;

describe("parseUnifiedDiff", () => {
  it("groups hunks by file and calculates additions/deletions", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      filepath: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(files[1]).toMatchObject({
      filepath: "src/new.ts",
      status: "added",
      additions: 2,
      deletions: 0,
    });
  });

  it("retains source line numbers for navigation", () => {
    const [step] = flattenWalkthrough(parseUnifiedDiff(SAMPLE));
    expect(step.newStart).toBe(1);
    expect(step.lines.find((line) => line.kind === "add")?.newLine).toBe(2);
    expect(step.lines.find((line) => line.kind === "remove")?.oldLine).toBe(2);
  });

  it("returns no fake steps for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
