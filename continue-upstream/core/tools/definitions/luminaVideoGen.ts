import { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";

export const luminaVideoGenTool: Tool = {
  type: "function",
  displayTitle: "Generate Video",
  wouldLikeTo: 'generate a video of "{{{ prompt }}}"',
  isCurrently: 'generating a video of "{{{ prompt }}}"',
  hasAlready: 'generated a video of "{{{ prompt }}}"',
  readonly: false,
  group: "Lumina",
  function: {
    name: BuiltInToolNames.GenerateVideo,
    description:
      "Generate a short video from a text prompt (optionally image-to-video) using " +
      "Replicate video models (default Kling). Returns the video URL and a saved " +
      "local file path. Requires REPLICATE_API_KEY and REPLICATE_VIDEO_MODEL in the root .env. " +
      "Generation takes ~1-3 minutes.",
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the video to generate.",
        },
        model: {
          type: "string",
          description: "Optional Replicate video model override (default REPLICATE_VIDEO_MODEL).",
        },
        durationSeconds: {
          type: "number",
          description: "Clip length in seconds (1-10, default 5).",
        },
        aspectRatio: {
          type: "string",
          description: "Aspect ratio like 16:9 or 9:16 (default 16:9).",
        },
        imageUrl: {
          type: "string",
          description: "Optional source image URL for image-to-video.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  systemMessageDescription: {
    prefix: `To create a short video from a description, call the ${BuiltInToolNames.GenerateVideo} tool with a prompt. For example:`,
    exampleArgs: [["prompt", "a drone shot flying over a misty mountain forest at sunrise"]],
  },
  toolCallIcon: "FilmIcon",
};
