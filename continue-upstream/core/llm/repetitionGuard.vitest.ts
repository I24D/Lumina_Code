import { describe, expect, it } from "vitest";

import { isRepetitionLoop, MIN_RESPONSE_CHARS } from "./repetitionGuard";

const SENTENCE =
  "The configuration file must be updated before the service restarts.\n";

/** Repeats `unit` until the result is comfortably past the size gate. */
function longEnough(unit: string): string {
  return unit.repeat(Math.ceil((MIN_RESPONSE_CHARS * 1.5) / unit.length));
}

describe("isRepetitionLoop", () => {
  describe("catches genuine loops", () => {
    it("flags one line repeated until it is the whole response", () => {
      expect(isRepetitionLoop(longEnough(SENTENCE))).toBe(true);
    });

    it("flags a loop with no line breaks to key off", () => {
      // Only the sliding window can see this one.
      const fragment =
        "I will now update the configuration and restart the service. ";
      expect(isRepetitionLoop(longEnough(fragment))).toBe(true);
    });

    it("flags a loop that starts after a legitimate answer", () => {
      const preamble =
        "Here is the fix you asked for, applied to the config loader.\n\n";
      expect(isRepetitionLoop(preamble + longEnough(SENTENCE))).toBe(true);
    });
  });

  describe("leaves legitimate text alone", () => {
    it("ignores a response below the size that makes looping a problem", () => {
      // Repetitive, but far too short to be worth throwing away.
      expect(isRepetitionLoop(SENTENCE.repeat(20))).toBe(false);
    });

    it("does not flag a long list whose rows share boilerplate", () => {
      // This is the case a pure coverage test gets wrong: the shared phrase is
      // longer than the window and repeats on every row, so overlapping
      // windows make it look dominant even though the rows are all distinct.
      const listing = Array.from(
        { length: 400 },
        (_, index) =>
          `Line ${index}: this describes a distinct step in the process, with its own detail.`,
      ).join("\n");
      expect(listing.length).toBeGreaterThan(MIN_RESPONSE_CHARS);
      expect(isRepetitionLoop(listing)).toBe(false);
    });

    it("does not flag a long markdown table", () => {
      const rows = Array.from(
        { length: 400 },
        (_, index) =>
          `| src/module_${index}/file_${index}.ts | ${index} | reviewed and found consistent with the surrounding code |`,
      ).join("\n");
      const table = `| File | Line | Notes |\n| --- | --- | --- |\n${rows}`;
      expect(table.length).toBeGreaterThan(MIN_RESPONSE_CHARS);
      expect(isRepetitionLoop(table)).toBe(false);
    });

    it("does not flag long varied prose", () => {
      const prose = Array.from(
        { length: 400 },
        (_, index) =>
          `Paragraph ${index} covers a separate concern entirely, with reasoning that does not resemble its neighbours in wording or structure at index ${index * 7}.`,
      ).join("\n\n");
      expect(isRepetitionLoop(prose)).toBe(false);
    });

    it("does not flag a padded blob", () => {
      // Base64 padding and rules of dashes are formatting, not a loop.
      const padded = `Here is the encoded asset:\n${"A".repeat(MIN_RESPONSE_CHARS * 2)}\n`;
      expect(isRepetitionLoop(padded)).toBe(false);
    });

    it("does not flag a long run of blank lines", () => {
      const text = `${"\n".repeat(MIN_RESPONSE_CHARS)}real content that is not repeated`;
      expect(isRepetitionLoop(text)).toBe(false);
    });

    it("handles an empty string", () => {
      expect(isRepetitionLoop("")).toBe(false);
    });
  });
});
