import { describe, expect, it } from "vitest";

import { setupProviderConfig } from "./onboarding";

describe("Ollama Cloud onboarding", () => {
  it("configures Kimi K3 as primary and keeps GLM-5.2 available", () => {
    const config = setupProviderConfig(
      { name: "Test", version: "1.0.0", schema: "v1" },
      "ollamaCloud",
      "ollama-test-key",
    );

    expect(config.models).toMatchObject([
      {
        name: "Kimi K3 (Ollama Cloud)",
        provider: "ollama",
        model: "kimi-k3:cloud",
        apiKey: "ollama-test-key",
        apiBase: "https://ollama.com/",
        roles: ["chat", "edit", "apply"],
        capabilities: ["tool_use", "image_input"],
      },
      {
        name: "GLM-5.2 (Ollama Cloud)",
        provider: "ollama",
        model: "glm-5.2:cloud",
        apiKey: "ollama-test-key",
        apiBase: "https://ollama.com/",
        roles: ["chat", "edit", "apply"],
        capabilities: ["tool_use"],
      },
    ]);
  });

  it("updates both credentials without duplicating either model", () => {
    const initial = setupProviderConfig(
      { name: "Test", version: "1.0.0", schema: "v1" },
      "ollamaCloud",
      "old-key",
    );
    const updated = setupProviderConfig(initial, "ollamaCloud", "new-key");

    const ollamaCloudModels = updated.models?.filter(
      (model) =>
        "provider" in model &&
        model.provider === "ollama" &&
        (model.model === "kimi-k3:cloud" || model.model === "glm-5.2:cloud"),
    );

    expect(ollamaCloudModels).toHaveLength(2);
    expect(
      ollamaCloudModels?.map((model) =>
        "apiKey" in model ? model.apiKey : undefined,
      ),
    ).toEqual(["new-key", "new-key"]);
  });

  it("promotes Kimi ahead of an existing GLM configuration", () => {
    const config = setupProviderConfig(
      {
        name: "Test",
        version: "1.0.0",
        schema: "v1",
        models: [
          {
            name: "GLM-5.2 (Ollama Cloud)",
            provider: "ollama",
            model: "glm-5.2:cloud",
            apiKey: "old-key",
            apiBase: "https://ollama.com/",
          },
          {
            name: "Local model",
            provider: "ollama",
            model: "qwen2.5-coder:7b",
          },
        ],
      },
      "ollamaCloud",
      "new-key",
    );

    expect(
      config.models?.map((model) =>
        "model" in model ? model.model : model.uses,
      ),
    ).toEqual(["kimi-k3:cloud", "glm-5.2:cloud", "qwen2.5-coder:7b"]);
  });
});
