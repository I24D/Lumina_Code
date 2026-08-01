import fs from "fs";
import os from "os";
import path from "path";

import { FetchFunction } from "../..";
import { readLuminaEnv } from "../../luminaBridge/luminaEnv";
import { ToolImpl } from ".";
import { getStringArg } from "../parseArgs";

type ImageResult = {
  url?: string;
  buffer?: Buffer;
  mimeType: string;
  provider: string;
  model: string;
};

const DEFAULT_CHAIN = ["replicate", "openai", "stability"];

// ── Providers (ported from src/cuerpo/Lumina_image-generation) ───────────────

async function replicateImage(
  fetchFn: FetchFunction,
  prompt: string,
  model: string,
): Promise<ImageResult> {
  const key = readLuminaEnv("REPLICATE_API_KEY");
  if (!key) throw new Error("REPLICATE_API_KEY not configured");
  const mdl = model || readLuminaEnv("REPLICATE_MODEL") || "black-forest-labs/flux-schnell";

  const createRes = await fetchFn(
    `https://api.replicate.com/v1/models/${mdl}/predictions` as any,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "wait=60",
      },
      body: JSON.stringify({
        input: { prompt, num_outputs: 1, output_format: "webp", output_quality: 90 },
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Replicate create (${createRes.status}): ${(await createRes.text()).slice(0, 200)}`);
  }
  const prediction: any = await createRes.json();
  const immediate = Array.isArray(prediction?.output) ? prediction.output[0] : prediction?.output;
  if (prediction?.status === "succeeded" && immediate) {
    return { url: immediate, mimeType: "image/webp", provider: "replicate", model: mdl };
  }
  const pollUrl = prediction?.urls?.get || `https://api.replicate.com/v1/predictions/${prediction?.id}`;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetchFn(pollUrl as any, { headers: { Authorization: `Bearer ${key}` } });
    if (!pollRes.ok) {
      throw new Error(`Replicate poll (${pollRes.status}): ${(await pollRes.text()).slice(0, 200)}`);
    }
    const result: any = await pollRes.json();
    const output = Array.isArray(result?.output) ? result.output[0] : result?.output;
    if (result?.status === "succeeded" && output) {
      return { url: output, mimeType: "image/webp", provider: "replicate", model: mdl };
    }
    if (result?.status === "failed" || result?.status === "canceled") {
      throw new Error(`Replicate ${result.status}: ${result.error || "unknown"}`);
    }
  }
  throw new Error("Replicate timed out waiting for the generated image");
}

const OPENAI_SIZES = ["1024x1024", "1024x1536", "1536x1024"];

async function openaiImage(
  fetchFn: FetchFunction,
  prompt: string,
  size: string,
  quality: string,
  model: string,
): Promise<ImageResult> {
  const key = readLuminaEnv("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  const mdl = model || readLuminaEnv("OPENAI_IMAGE_MODEL") || "gpt-image-1";
  const normalizedSize = OPENAI_SIZES.includes(size)
    ? size
    : size === "1792x1024"
      ? "1536x1024"
      : size === "1024x1792"
        ? "1024x1536"
        : "1024x1024";
  const q = ["low", "medium", "high"].includes(quality) ? quality : "high";
  const res = await fetchFn("https://api.openai.com/v1/images/generations" as any, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: mdl, prompt, n: 1, size: normalizedSize, quality: q }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI Images ${mdl} (${res.status}): ${(await res.text()).slice(0, 220)}`);
  }
  const data: any = await res.json();
  const first = data?.data?.[0];
  if (first?.url) {
    return { url: first.url, mimeType: "image/png", provider: "openai", model: mdl };
  }
  if (first?.b64_json) {
    return {
      buffer: Buffer.from(first.b64_json, "base64"),
      mimeType: "image/png",
      provider: "openai",
      model: mdl,
    };
  }
  throw new Error(`OpenAI ${mdl} returned no image`);
}

async function stabilityImage(
  fetchFn: FetchFunction,
  prompt: string,
  size: string,
  model: string,
): Promise<ImageResult> {
  const key = readLuminaEnv("STABILITY_API_KEY");
  if (!key) throw new Error("STABILITY_API_KEY not configured");
  const mdl = model || readLuminaEnv("STABILITY_MODEL") || "stable-diffusion-xl-1024-v1-0";
  const m = /^(\d{2,5})x(\d{2,5})$/u.exec(size || "1024x1024");
  const width = Number(m?.[1] || 1024);
  const height = Number(m?.[2] || 1024);
  const res = await fetchFn(
    `https://api.stability.ai/v1/generation/${mdl}/text-to-image` as any,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        text_prompts: [
          { text: prompt, weight: 1 },
          { text: "blurry, low quality, distorted, ugly, bad anatomy", weight: -1 },
        ],
        cfg_scale: 7,
        width,
        height,
        steps: 30,
        samples: 1,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Stability AI (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json();
  const artifact = data?.artifacts?.[0];
  if (!artifact?.base64) throw new Error("Stability AI returned no image");
  return {
    buffer: Buffer.from(artifact.base64, "base64"),
    mimeType: "image/png",
    provider: "stability",
    model: mdl,
  };
}

// ── Save + orchestration ─────────────────────────────────────────────────────

function extFor(mime: string): string {
  if (mime.includes("webp")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "png";
}

async function saveMedia(
  fetchFn: FetchFunction,
  result: ImageResult,
  kind: "image" | "video",
): Promise<string> {
  const dir = path.join(os.tmpdir(), "lumina-media");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const file = path.join(dir, `lumina-${kind}-${stamp}.${extFor(result.mimeType)}`);
  let buffer = result.buffer;
  if (!buffer && result.url) {
    const r = await fetchFn(result.url as any, {});
    buffer = Buffer.from(await r.arrayBuffer());
  }
  if (!buffer) throw new Error("no media bytes to save");
  fs.writeFileSync(file, buffer);
  return file;
}

export const luminaImageGenImpl: ToolImpl = async (args, extras) => {
  const prompt = getStringArg(args, "prompt");
  const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  const model = typeof args.model === "string" ? args.model.trim() : "";
  const size = typeof args.size === "string" ? args.size.trim() : readLuminaEnv("IMAGE_GEN_SIZE") || "1024x1024";
  const quality = typeof args.quality === "string" ? args.quality.trim() : readLuminaEnv("IMAGE_GEN_QUALITY") || "high";

  const chain = provider
    ? [provider]
    : (readLuminaEnv("IMAGE_PROVIDERS") || DEFAULT_CHAIN.join(","))
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);

  const errors: string[] = [];
  for (const p of chain) {
    try {
      let result: ImageResult;
      if (p === "replicate" || p === "flux") result = await replicateImage(extras.fetch, prompt, model);
      else if (p === "openai" || p === "dalle") result = await openaiImage(extras.fetch, prompt, size, quality, model);
      else if (p === "stability" || p === "sdxl") result = await stabilityImage(extras.fetch, prompt, size, model);
      else continue; // unknown/unsupported provider (e.g. "var" local service)

      const localPath = await saveMedia(extras.fetch, result, "image").catch(() => undefined);
      const lines = [
        `Image generated with ${result.provider} (${result.model}).`,
        result.url ? `URL: ${result.url}` : "",
        localPath ? `Saved: ${localPath}` : "",
      ].filter(Boolean);
      return [
        {
          name: "Generated image",
          description: prompt.slice(0, 100),
          content: lines.join("\n"),
        },
      ];
    } catch (e) {
      errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(
    `Image generation failed. Configure a provider key in the root .env ` +
      `(REPLICATE_API_KEY / OPENAI_API_KEY / STABILITY_API_KEY). Tried: ${errors.join(" | ") || "none available"}`,
  );
};

export { saveMedia };
export type { ImageResult };
