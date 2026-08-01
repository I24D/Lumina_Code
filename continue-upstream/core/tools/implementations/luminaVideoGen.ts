import { FetchFunction } from "../..";
import { readLuminaEnv } from "../../luminaBridge/luminaEnv";
import { ToolImpl } from ".";
import { getStringArg } from "../parseArgs";
import { saveMedia, type ImageResult } from "./luminaImageGen";

// Ported from src/cuerpo/Lumina_video-generation — Replicate video (create → poll).
async function replicateVideo(
  fetchFn: FetchFunction,
  prompt: string,
  model: string,
  durationSeconds: number,
  aspectRatio: string,
  imageUrl: string,
): Promise<ImageResult> {
  const key = readLuminaEnv("REPLICATE_API_KEY");
  if (!key) throw new Error("REPLICATE_API_KEY not configured");
  const mdl = model || readLuminaEnv("REPLICATE_VIDEO_MODEL") || "kwaivgi/kling-v1.6-standard";

  const input: Record<string, unknown> = {
    prompt,
    duration: Math.max(1, Math.min(10, Math.round(durationSeconds || 5))),
    aspect_ratio: aspectRatio || readLuminaEnv("VIDEO_GEN_ASPECT_RATIO") || "16:9",
  };
  if (imageUrl) input.image = imageUrl;

  const createRes = await fetchFn(
    `https://api.replicate.com/v1/models/${mdl}/predictions` as any,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({ input }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Replicate video create (${createRes.status}): ${(await createRes.text()).slice(0, 200)}`);
  }
  const prediction: any = await createRes.json();
  const immediate = Array.isArray(prediction?.output) ? prediction.output[0] : prediction?.output;
  if (prediction?.status === "succeeded" && immediate) {
    return { url: immediate, mimeType: "video/mp4", provider: "replicate", model: mdl };
  }
  const pollUrl = prediction?.urls?.get || `https://api.replicate.com/v1/predictions/${prediction?.id}`;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetchFn(pollUrl as any, { headers: { Authorization: `Bearer ${key}` } });
    if (!pollRes.ok) {
      throw new Error(`Replicate video poll (${pollRes.status}): ${(await pollRes.text()).slice(0, 200)}`);
    }
    const result: any = await pollRes.json();
    const output = Array.isArray(result?.output) ? result.output[0] : result?.output;
    if (result?.status === "succeeded" && output) {
      return { url: output, mimeType: "video/mp4", provider: "replicate", model: mdl };
    }
    if (result?.status === "failed" || result?.status === "canceled") {
      throw new Error(`Replicate video ${result.status}: ${result.error || "unknown"}`);
    }
  }
  throw new Error("Replicate video timed out waiting for the generated video");
}

export const luminaVideoGenImpl: ToolImpl = async (args, extras) => {
  const prompt = getStringArg(args, "prompt");
  const model = typeof args.model === "string" ? args.model.trim() : "";
  const durationSeconds = typeof args.durationSeconds === "number" ? args.durationSeconds : 5;
  const aspectRatio = typeof args.aspectRatio === "string" ? args.aspectRatio.trim() : "";
  const imageUrl = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";

  const result = await replicateVideo(
    extras.fetch,
    prompt,
    model,
    durationSeconds,
    aspectRatio,
    imageUrl,
  );
  const localPath = await saveMedia(extras.fetch, result, "video").catch(() => undefined);
  const lines = [
    `Video generated with ${result.provider} (${result.model}).`,
    result.url ? `URL: ${result.url}` : "",
    localPath ? `Saved: ${localPath}` : "",
  ].filter(Boolean);
  return [
    {
      name: "Generated video",
      description: prompt.slice(0, 100),
      content: lines.join("\n"),
    },
  ];
};
