import { describe, expect, it } from "vitest";

import { findSearchMatch } from "./findSearchMatch";

/** The text the match landed on, which is what a replace would overwrite. */
function matched(file: string, search: string): string | null {
  const result = findSearchMatch(file, search);
  return result ? file.slice(result.startIndex, result.endIndex) : null;
}

function strategy(file: string, search: string): string | undefined {
  return findSearchMatch(file, search)?.strategyName;
}

describe("escape-normalised matching", () => {
  const file = 'function greet() {\n  return "hi";\n}\n';

  it("matches search text where the model wrote a literal backslash-n", () => {
    // The model composed the edit inside a JSON string and emitted the two
    // characters `\` and `n` where the file has a real newline.
    const search = 'function greet() {\\n  return "hi";\\n}';

    expect(matched(file, search)).toBe('function greet() {\n  return "hi";\n}');
    expect(strategy(file, search)).toBe("escapeNormalizedMatch");
  });

  it("handles a literal backslash-r-backslash-n pair", () => {
    expect(matched(file, 'function greet() {\\r\\n  return "hi";')).toBe(
      'function greet() {\n  return "hi";',
    );
  });

  it("handles a literal tab escape", () => {
    const tabbed = "if (x) {\n\treturn 1;\n}";
    expect(matched(tabbed, "\\treturn 1;")).toBe("\treturn 1;");
  });

  it("reports the match against the untouched file", () => {
    const result = findSearchMatch(file, 'return "hi";')!;
    // Indices must index the original content, or a replace corrupts the file.
    expect(file.slice(result.startIndex, result.endIndex)).toBe('return "hi";');
  });

  it("does not claim a match when the escapes were not the problem", () => {
    expect(findSearchMatch(file, "nothing\\nlike this")).toBeNull();
  });

  it("leaves a genuine backslash-n in the file alone", () => {
    // Here the file really does contain the two characters, e.g. inside a
    // regex or a docstring, and an exact match is correct.
    const withLiteral = 'const re = /a\\nb/;';
    expect(strategy(withLiteral, 'a\\nb')).toBe("exactMatch");
  });
});

describe("typography-normalised matching", () => {
  it("matches straight quotes against curly ones in the file", () => {
    const file = 'const msg = “hello”;';
    const search = 'const msg = "hello";';

    expect(matched(file, search)).toBe(file);
    expect(strategy(file, search)).toBe("typographyNormalizedMatch");
  });

  it("matches curly quotes against straight ones in the file", () => {
    const file = 'const msg = "hello";';
    expect(matched(file, 'const msg = “hello”;')).toBe(file);
  });

  it("matches an apostrophe that was prettified", () => {
    const file = "// don’t touch this";
    expect(matched(file, "// don't touch this")).toBe(file);
  });

  it.each([
    ["en dash", "–"],
    ["em dash", "—"],
    ["non-breaking hyphen", "‑"],
  ])("matches a hyphen against an %s", (_label, dash) => {
    const file = `a ${dash} b`;
    expect(matched(file, "a - b")).toBe(file);
  });

  it("matches a normal space against a non-breaking one", () => {
    const file = "value: 42";
    expect(matched(file, "value: 42")).toBe(file);
  });

  it("returns indices that still line up with the original file", () => {
    // The whole point of restricting this to same-width substitutions: a
    // shifted index would make the replace overwrite the wrong characters.
    const file = 'x = “abc”; y = 1;';
    const result = findSearchMatch(file, '"abc"')!;

    expect(file.slice(result.startIndex, result.endIndex)).toBe(
      "“abc”",
    );
  });

  it("does not invent a match between genuinely different text", () => {
    expect(findSearchMatch('const a = "x";', '"totally different"')).toBeNull();
  });
});

describe("strategy precedence", () => {
  it("prefers an exact match over any normalisation", () => {
    const file = 'a = "one";\na = “one”;';
    expect(strategy(file, 'a = "one";')).toBe("exactMatch");
  });

  it("still falls through to the lossy strategies when nothing else fits", () => {
    const file = "const VALUE = 1;";
    // Case-insensitive is lossy but remains the last resort it always was.
    expect(strategy(file, "const value = 1;")).toBe("caseInsensitiveMatch");
  });

  it("keeps similarity-based matching switched off", () => {
    // A near-miss must fail loudly rather than be replaced on a guess.
    expect(
      findSearchMatch(
        "function computeTotal(items) { return 1; }",
        "function computeTotals(item) { return 2; }",
      ),
    ).toBeNull();
  });
});
