import { DurableObject } from "cloudflare:workers";

const MS_PER_SECOND = 1000;
const BUCKET_KEY = "bucket";
const UNKNOWN_CALLER = "unknown";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter extends DurableObject {
  private tokens?: number;
  private updatedAt?: number;

  async take(
    capacity: number,
    refillSeconds: number,
  ): Promise<{ ok: boolean; retryAfter: number }> {
    const now = Date.now() / MS_PER_SECOND;

    await this.restore(capacity, now);
    this.refill(capacity, refillSeconds, now);

    const tokens = this.tokens as number;
    if (tokens < 1) {
      return {
        ok: false,
        retryAfter: Math.ceil((1 - tokens) * refillSeconds),
      };
    }

    this.tokens = tokens - 1;
    await this.ctx.storage.put(BUCKET_KEY, {
      tokens: this.tokens,
      updatedAt: this.updatedAt,
    });

    return { ok: true, retryAfter: 0 };
  }

  private async restore(capacity: number, now: number): Promise<void> {
    if (this.tokens !== undefined) return;

    const stored = await this.ctx.storage.get<Bucket>(BUCKET_KEY);
    this.tokens = stored?.tokens ?? capacity;
    this.updatedAt = stored?.updatedAt ?? now;
  }

  private refill(capacity: number, refillSeconds: number, now: number): void {
    const elapsed = Math.max(0, now - (this.updatedAt ?? now));
    this.tokens = Math.min(
      capacity,
      (this.tokens as number) + elapsed / refillSeconds,
    );
    this.updatedAt = now;
  }
}

export function callerKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? UNKNOWN_CALLER;
}
