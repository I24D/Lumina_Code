import { describe, expect, it } from "vitest";
import { assertBrowserBuildWarningIsSafe } from "./browserBuildGuard";

describe("assertBrowserBuildWarningIsSafe", () => {
  it("fails the build when Vite externalizes a Node module", () => {
    expect(() =>
      assertBrowserBuildWarningIsSafe(
        'Module "node:fs" has been externalized for browser compatibility, imported by "core/example.ts".',
      ),
    ).toThrow(/node-only code reached the lumina webview bundle/i);
  });

  it("allows unrelated optimization warnings", () => {
    expect(() =>
      assertBrowserBuildWarningIsSafe("Some chunks are larger than 500 kB"),
    ).not.toThrow();
  });
});
