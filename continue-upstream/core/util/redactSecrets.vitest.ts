import { describe, expect, it } from "vitest";

import { containsSecret, redactSecrets } from "./redactSecrets";

function redact(text: string): string {
  return redactSecrets(text).text;
}

/**
 * Assembles a fixture that has a credential's shape without ever appearing as
 * one in the source.
 *
 * These fixtures have to look real enough to exercise the patterns, which is
 * exactly what makes a secret scanner flag them — GitHub's push protection
 * blocks the Slack shape outright, and it is right to: it cannot tell this one
 * is invented. Joining the parts at runtime keeps the committed file clean
 * while the value under test is identical.
 */
function shaped(...parts: string[]): string {
  return parts.join("");
}

const BODY = "abcdefghijklmnopqrstuvwxyz0123456789";

describe("redactSecrets", () => {
  describe("vendor-prefixed keys", () => {
    it.each([
      ["OpenAI", shaped("sk", "-", BODY)],
      ["GitHub PAT", shaped("ghp", "_", BODY)],
      ["GitHub fine-grained", shaped("github", "_pat_", "abcdefghijklmnop123456789")],
      ["GitLab", shaped("glpat", "-", "abcdefghijklmnopqrst")],
      ["Slack bot", shaped("xox", "b-", "123456789012-abcdefghijklmnop")],
      ["Google", shaped("AIza", "a".repeat(35))],
      ["AWS access key", shaped("AKIA", "IOSFODNN7EXAMPLE")],
      ["Stripe live", shaped("sk", "_live_", "abcdefghijklmnop1234")],
      ["HuggingFace", shaped("hf", "_", "abcdefghijklmnopqrstuvwx")],
    ])("masks a %s key", (_label, secret) => {
      const output = redact(`the key is ${secret} ok`);
      expect(output).not.toContain(secret);
      expect(output).toContain("the key is");
      expect(output).toContain("ok");
    });

    it("keeps the ends so an incident is still diagnosable", () => {
      const output = redact(shaped("ghp", "_", BODY));
      expect(output).toMatch(/^ghp_ab\.\.\./u);
    });
  });

  it("removes an entire private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxx",
      "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const output = redact(`before\n${pem}\nafter`);
    expect(output).toContain("[REDACTED PRIVATE KEY]");
    expect(output).not.toContain("MIIEowIBAAKCAQEA");
    expect(output).toContain("before");
    expect(output).toContain("after");
  });

  it("masks a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redact(`token=${jwt}`)).not.toContain(jwt);
  });

  describe("headers", () => {
    it("masks the credential but keeps the scheme", () => {
      const output = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
      expect(output).toContain("Authorization: Bearer");
      expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    });

    it("masks an opaque api-key header", () => {
      const output = redact("x-api-key: abcdefghijklmnopqrstuvwxyz");
      expect(output).toContain("x-api-key:");
      expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    });
  });

  describe("URLs", () => {
    it("masks the password in a connection string", () => {
      const output = redact("postgres://admin:hunter2pass@db.internal:5432/app");
      expect(output).not.toContain("hunter2pass");
      // The rest still has to be readable — it is why the user ran the command.
      expect(output).toContain("db.internal:5432/app");
      expect(output).toContain("admin");
    });

    it("masks a token embedded in a git remote", () => {
      const token = shaped("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123");
      const output = redact(
        `origin https://${token}@github.com/me/repo.git`,
      );
      expect(output).not.toContain(token);
      expect(output).toContain("github.com/me/repo.git");
    });
  });

  describe("assignments", () => {
    it.each([
      "OPENAI_API_KEY=abcdefghijklmnopqrst",
      'API_TOKEN="abcdefghijklmnopqrst"',
      '"clientSecret": "abcdefghijklmnopqrst"',
      "db_password: abcdefghijklmnopqrst",
    ])("masks %s", (line) => {
      expect(redact(line)).not.toContain("abcdefghijklmnopqrst");
    });

    it("leaves the key name visible so the line still means something", () => {
      expect(redact("OPENAI_API_KEY=abcdefghijklmnopqrst")).toContain(
        "OPENAI_API_KEY=",
      );
    });
  });

  describe("false positives", () => {
    it("does not touch code that only reads a variable", () => {
      // Masking these mangles source the user is trying to work on, and
      // reading a variable discloses nothing.
      const code = 'const key = process.env.OPENAI_API_KEY;';
      expect(redact(code)).toBe(code);
    });

    it.each([
      "The secretary approved it",
      "The tokenizer splits on whitespace",
      "authored by someone else",
    ])("leaves ordinary prose alone: %s", (prose) => {
      expect(redact(prose)).toBe(prose);
    });

    it("leaves text with no credentials completely unchanged", () => {
      const log = "npm warn deprecated foo@1.0.0\n42 packages audited\n";
      expect(redact(log)).toBe(log);
      expect(containsSecret(log)).toBe(false);
    });

    it("does not mask a short username in a URL", () => {
      const url = "https://me@example.com/path";
      expect(redact(url)).toBe(url);
    });
  });

  it("reports which rules fired", () => {
    const result = redactSecrets(
      "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    );
    expect(result.rules).toContain("authorization-header");
    expect(
      containsSecret(shaped("ghp", "_", "abcdefghijklmnopqrstuvwxyz0123")),
    ).toBe(true);
  });

  it("handles empty input", () => {
    expect(redactSecrets("")).toEqual({ text: "", rules: [] });
  });
});
