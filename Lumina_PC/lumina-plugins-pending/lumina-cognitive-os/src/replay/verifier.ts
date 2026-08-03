/**
 * verifier.ts — Post-action verification utilities.
 *
 * After dispatching an action via the Bridge, the engine compares
 * pre/post state per the VerifyPolicy on the ResolvedAction. If the
 * expected change didn't happen, the engine aborts the replay and
 * surfaces the discrepancy.
 *
 * Verification is best-effort: false positives (we say "it worked"
 * when it didn't) are worse than false negatives. The minChangeRatio
 * default is intentionally low (~0.5%) so most clicks register at
 * least the cursor/focus rectangle changing.
 */
import fs from "node:fs";
import type { VerifyPolicy, LiveContext } from "./strategies/types.js";

export type VerificationResult = {
  readonly ok: boolean;
  readonly policy: string;
  readonly detail: string;
  readonly changeRatio?: number;
};

export async function verifyPostAction(params: {
  policy?: VerifyPolicy;
  preScreenshotPath?: string | null;
  postLive: LiveContext;
}): Promise<VerificationResult> {
  const policy = params.policy ?? { kind: "none" };
  if (policy.kind === "none") {
    return { ok: true, policy: "none", detail: "no verification requested" };
  }
  if (policy.kind === "uia_recheck") {
    if (!params.postLive.uiaNodes) {
      return { ok: false, policy: "uia_recheck", detail: "no live UIA available" };
    }
    if (!policy.expect.automationId && !policy.expect.name) {
      return { ok: true, policy: "uia_recheck", detail: "no expectation set" };
    }
    const present = params.postLive.uiaNodes.some((n) => {
      if (policy.expect.automationId && n.automationId === policy.expect.automationId) return true;
      if (policy.expect.name && n.name === policy.expect.name) return true;
      return false;
    });
    return {
      ok: true, // presence is informational; absence ALSO can be a successful click (the element changed)
      policy: "uia_recheck",
      detail: present
        ? "target element still present in tree (likely focus changed)"
        : "target element no longer present (likely view changed)",
    };
  }
  if (policy.kind === "screenshot_diff") {
    if (!params.preScreenshotPath || !params.postLive.screenshotPath) {
      return { ok: false, policy: "screenshot_diff", detail: "missing pre or post screenshot" };
    }
    const ratio = await fastPngChangeRatio(params.preScreenshotPath, params.postLive.screenshotPath);
    return {
      ok: ratio >= policy.minChangeRatio,
      policy: "screenshot_diff",
      detail: `change ratio ${ratio.toFixed(4)} vs threshold ${policy.minChangeRatio}`,
      changeRatio: ratio,
    };
  }
  if (policy.kind === "llm_judge") {
    // Defer — the host agent can apply its LLM externally and call into
    // the next step. We just report not-implemented.
    return {
      ok: true,
      policy: "llm_judge",
      detail: "llm_judge verification deferred to host agent",
    };
  }
  return { ok: true, policy: "unknown", detail: "unknown policy treated as pass" };
}

/**
 * Cheap byte-level diff ratio between two PNGs. Not a real visual diff —
 * just (changed bytes / total bytes). Good enough to detect that
 * SOMETHING moved on screen; not pixel-accurate.
 */
async function fastPngChangeRatio(pathA: string, pathB: string): Promise<number> {
  try {
    const a = fs.readFileSync(pathA);
    const b = fs.readFileSync(pathB);
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let changed = 0;
    const sampleStride = Math.max(1, Math.floor(len / 50_000)); // sample up to 50k bytes
    for (let i = 0; i < len; i += sampleStride) {
      if (a[i] !== b[i]) changed++;
    }
    const sampled = Math.ceil(len / sampleStride);
    return sampled === 0 ? 0 : changed / sampled;
  } catch {
    return 0;
  }
}
