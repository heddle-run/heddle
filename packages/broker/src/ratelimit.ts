import { DurableObject } from "cloudflare:workers";

/**
 * A token bucket per caller, held in a Durable Object.
 *
 * A Durable Object rather than a platform rate-limiting binding because this
 * limit is the thing standing between the internet and a service that runs
 * submitted code. It is worth being able to read the algorithm, and worth not
 * having its semantics change underneath the deployment.
 *
 * One object per caller key, so the object *is* the bucket and there is no
 * contention between callers. State lives in memory with a storage backstop:
 * an eviction costs a caller a refilled bucket, which is the safe direction to
 * fail only because the alternative — persisting on every request — would make
 * the limiter more expensive than the thing it protects.
 */
export class RateLimiter extends DurableObject {
  private tokens?: number;
  private updatedAt?: number;

  /**
   * Take a token.
   *
   * `capacity` is the burst a caller may spend at once; `refillSeconds` is how
   * long one token takes to come back. Both are passed per call so the policy
   * lives with the route rather than in this object.
   */
  async take(
    capacity: number,
    refillSeconds: number,
  ): Promise<{ ok: boolean; retryAfter: number }> {
    const now = Date.now() / 1000;

    if (this.tokens === undefined) {
      const stored = await this.ctx.storage.get<{
        tokens: number;
        updatedAt: number;
      }>("bucket");
      this.tokens = stored?.tokens ?? capacity;
      this.updatedAt = stored?.updatedAt ?? now;
    }

    const elapsed = Math.max(0, now - (this.updatedAt ?? now));
    this.tokens = Math.min(capacity, this.tokens + elapsed / refillSeconds);
    this.updatedAt = now;

    if (this.tokens < 1) {
      const retryAfter = Math.ceil((1 - this.tokens) * refillSeconds);
      return { ok: false, retryAfter };
    }

    this.tokens -= 1;
    await this.ctx.storage.put("bucket", {
      tokens: this.tokens,
      updatedAt: this.updatedAt,
    });

    return { ok: true, retryAfter: 0 };
  }
}

/**
 * Who a limit applies to.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client,
 * unlike `X-Forwarded-For`. Requests without it are bucketed together under a
 * single key rather than allowed through unmetered.
 */
export function callerKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
