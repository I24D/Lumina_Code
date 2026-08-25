import { describe, expect, it } from "vitest";

import {
  classifyLlmError,
  describeLlmError,
  LlmErrorCategory,
} from "./classifyLlmError";

function categoryOf(message: string): LlmErrorCategory {
  return classifyLlmError(message).category;
}

describe("classifyLlmError", () => {
  describe("context exhaustion", () => {
    it.each([
      "This model's maximum context length is 128000 tokens",
      "Error code: 400 - context_length_exceeded",
      "Not enough context available",
      "Please reduce the length of the messages",
    ])("recognises %j", (message) => {
      expect(categoryOf(message)).toBe("out-of-context");
    });

    it("wins over the status code that carries it", () => {
      // A 400 that says the context is too long is a context problem, not a
      // malformed request, and telling the user to fix their JSON would send
      // them the wrong way.
      expect(
        categoryOf("400 Bad Request: maximum context length exceeded"),
      ).toBe("out-of-context");
    });

    it("says how to recover rather than just naming the failure", () => {
      const diagnosis = classifyLlmError("maximum context length is 8192");
      expect(diagnosis.guidance).toMatch(/compact/iu);
      expect(diagnosis.retryable).toBe(false);
    });
  });

  describe("credentials", () => {
    it.each([
      "401 Unauthorized",
      "Error code: 403",
      "Incorrect API key provided",
      "You have not set an API key",
      "authentication_error",
    ])("recognises %j", (message) => {
      expect(categoryOf(message)).toBe("auth");
    });

    it("does not suggest retrying, because the key will not fix itself", () => {
      expect(classifyLlmError("401 Unauthorized").retryable).toBe(false);
    });
  });

  describe("rate limit versus exhausted account", () => {
    it("treats a 429 that says when it resets as throttling", () => {
      expect(
        categoryOf("429 Too Many Requests. Please retry after 20s"),
      ).toBe("rate-limit");
    });

    it("treats an exhausted quota with no reset as a billing problem", () => {
      // Waiting is the wrong advice here, and it is the advice a bare "429"
      // would otherwise get.
      expect(
        categoryOf("429: You exceeded your current quota, insufficient_quota"),
      ).toBe("billing");
    });

    it("recognises 402 outright", () => {
      expect(categoryOf("402 Payment Required")).toBe("billing");
    });

    it("keeps a per-minute quota message as a rate limit", () => {
      expect(
        categoryOf("Rate limit reached: 200000 tokens per minute"),
      ).toBe("rate-limit");
    });

    it("tells the user plainly that waiting will not help", () => {
      const diagnosis = classifyLlmError("insufficient credit balance");
      expect(diagnosis.guidance).toMatch(/waiting will not help/iu);
      expect(diagnosis.retryable).toBe(false);
    });
  });

  describe("model names", () => {
    it.each([
      "404 Not Found",
      "The model `gpt-9` does not exist",
      "unknown model",
    ])("recognises %j", (message) => {
      expect(categoryOf(message)).toBe("model-not-found");
    });
  });

  describe("provider-side blocks and outages", () => {
    it.each([
      ["content policy violation", "content-policy"],
      ["Request was blocked by the content filter", "content-policy"],
      ["529 Overloaded", "server-error"],
      ["502 Bad Gateway", "server-error"],
      ["Internal server error", "server-error"],
    ])("classifies %j as %s", (message, expected) => {
      expect(categoryOf(message)).toBe(expected);
    });

    it("marks an outage retryable and says it is not the user's fault", () => {
      const diagnosis = classifyLlmError("503 Service Unavailable");
      expect(diagnosis.retryable).toBe(true);
      expect(diagnosis.guidance).toMatch(/their side/iu);
    });
  });

  describe("transport", () => {
    it.each([
      "connect ECONNREFUSED 127.0.0.1:11434",
      "getaddrinfo ENOTFOUND api.example.com",
      "fetch failed",
      "socket hang up",
      "unable to verify the first certificate",
    ])("recognises %j", (message) => {
      expect(categoryOf(message)).toBe("network");
    });

    it("mentions the local-model case, which is the usual cause", () => {
      const diagnosis = classifyLlmError("connect ECONNREFUSED 127.0.0.1:11434");
      expect(diagnosis.guidance).toMatch(/running/iu);
    });
  });

  describe("when nothing is recognisable", () => {
    it.each(["", "   ", "something went wrong"])(
      "falls back to unknown for %j",
      (message) => {
        expect(categoryOf(message)).toBe("unknown");
      },
    );

    it("still gives the user somewhere to go", () => {
      // An error with no advice is the state this classifier exists to end.
      const diagnosis = classifyLlmError("something went wrong");
      expect(diagnosis.guidance.length).toBeGreaterThan(0);
      expect(diagnosis.title.length).toBeGreaterThan(0);
    });
  });

  it("is case-insensitive", () => {
    expect(categoryOf("RATE LIMIT EXCEEDED")).toBe("rate-limit");
  });

  describe("describeLlmError", () => {
    const categories: LlmErrorCategory[] = [
      "out-of-context",
      "auth",
      "billing",
      "rate-limit",
      "model-not-found",
      "content-policy",
      "server-error",
      "network",
      "unknown",
    ];

    it.each(categories)("has wording for %s", (category) => {
      const diagnosis = describeLlmError(category);
      expect(diagnosis.category).toBe(category);
      expect(diagnosis.title.length).toBeGreaterThan(0);
      expect(diagnosis.guidance.length).toBeGreaterThan(0);
    });

    it("looks the wording up rather than re-classifying the category name", () => {
      // The chat UI stores a category, not the provider's text. Running
      // detection on "rate-limit" would fall through to unknown, because the
      // hyphenated name does not contain the phrase the rules look for.
      expect(describeLlmError("rate-limit").category).toBe("rate-limit");
      expect(classifyLlmError("rate-limit").category).toBe("unknown");
    });

    it("agrees with the classifier on wording", () => {
      expect(classifyLlmError("402 Payment Required")).toEqual(
        describeLlmError("billing"),
      );
    });
  });

  it("does not read a status code out of an unrelated number", () => {
    // "404" here is a token count, not a status, and misreading it would
    // send the user hunting for a model name that is perfectly fine.
    expect(categoryOf("Generated 404 tokens successfully")).not.toBe(
      "model-not-found",
    );
  });
});
