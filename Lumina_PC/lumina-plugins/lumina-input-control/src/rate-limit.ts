/**
 * Tiny in-process rate limiter. Each tool gets its own bucket. The cap
 * prevents the agent from spamming inputs and prevents runaway loops in
 * faulty code from sending thousands of keystrokes.
 */

export class RateLimiter {
  private readonly bucket: number[] = [];

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}

  consume(): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    while (this.bucket.length > 0 && now - (this.bucket[0] ?? 0) > this.windowMs) {
      this.bucket.shift();
    }
    if (this.bucket.length >= this.maxPerWindow) {
      const oldest = this.bucket[0] ?? now;
      return { ok: false, retryAfterMs: this.windowMs - (now - oldest) };
    }
    this.bucket.push(now);
    return { ok: true };
  }
}
