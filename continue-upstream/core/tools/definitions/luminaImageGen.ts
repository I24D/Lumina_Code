import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

export const luminaImageGenTool: Tool = {
  type: "function",
  displayTitle: "Generate Image",
  wouldLikeTo: 'generate an image of "{{{ prompt }}}"',
  isCurrently: 'generating an image of "{{{ prompt }}}"',
  hasAlready: 'generated an image of "{{{ prompt }}}"',
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.GenerateImage,
    description:
      "Generate an image from a text prompt using Lumina's image providers " +
      "(Replicate/Flux, OpenAI gpt-image, Stability SDXL). Returns the image URL " +
      "and a saved local file path. Requires a provider key in the root .env " +
      "(REPLICATE_API_KEY / OPENAI_API_KEY / STABILITY_API_KEY). Provider order " +
      "defaults to IMAGE_PROVIDERS.",
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate.",
        },
        provider: {
          type: "string",
          description:
            "Optional provider: replicate | openai | stability. Default: chain from IMAGE_PROVIDERS.",
        },
        model: {
          type: "string",
          description: "Optional model override for the chosen provider.",
        },
        size: {
          type: "string",
          description: "Optional size like 1024x1024 (OpenAI / Stability).",
        },
        quality: {
          type: "string",
          description: "Optional OpenAI quality: low | medium | high.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  systemMessageDescription: {
    prefix: `To create an image from a description, call the ${BuiltInToolNames.GenerateImage} tool with a prompt. For example:`,
    exampleArgs: [["prompt", "a neon cyberpunk city at night, cinematic, ultra detailed"]],
  },
  toolCallIcon: "PhotoIcon",
};
