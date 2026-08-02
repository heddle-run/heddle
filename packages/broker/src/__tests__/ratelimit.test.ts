import { afterEach, describe, expect, it, vi } from 'vitest';
import { callerKey, RateLimiter } from '../ratelimit';

const CAPACITY = 6;
const REFILL_SECONDS = 10; // one token back every 10s, as 6-a-minute would be

interface FakeState {
  state: DurableObjectState;
  stored: Map<string, unknown>;
}

/** Storage is the only part of DurableObjectState the limiter touches. */
function fakeState(stored = new Map<string, unknown>()): FakeState {
  const state = {
    storage: {
      get: (key: string) => Promise.resolve(stored.get(key)),
      put: (key: string, value: unknown) => {
        stored.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as DurableObjectState;

  return { state, stored };
}

function limiter(backing: FakeState = fakeState()): RateLimiter {
  return new RateLimiter(backing.state, {});
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter.take', () => {
  it('allows up to capacity and refuses the request after', async () => {
    vi.useFakeTimers();
    const bucket = limiter();

    for (let i = 0; i < CAPACITY; i++) {
      expect((await bucket.take(CAPACITY, REFILL_SECONDS)).ok).toBe(true);
    }

    const refused = await bucket.take(CAPACITY, REFILL_SECONDS);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
  });

  it('tells a refused caller when a token will be back', async () => {
    vi.useFakeTimers();
    const bucket = limiter();

    for (let i = 0; i < CAPACITY; i++) {
      await bucket.take(CAPACITY, REFILL_SECONDS);
    }

    const refused = await bucket.take(CAPACITY, REFILL_SECONDS);
    expect(refused.retryAfter).toBeLessThanOrEqual(REFILL_SECONDS);
  });

  it('lets a drained caller back in once the window rolls over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const bucket = limiter();

    for (let i = 0; i < CAPACITY; i++) {
      await bucket.take(CAPACITY, REFILL_SECONDS);
    }
    expect((await bucket.take(CAPACITY, REFILL_SECONDS)).ok).toBe(false);

    vi.setSystemTime(REFILL_SECONDS * 1000);

    expect((await bucket.take(CAPACITY, REFILL_SECONDS)).ok).toBe(true);
    // Exactly one token came back, so the next request is refused again.
    expect((await bucket.take(CAPACITY, REFILL_SECONDS)).ok).toBe(false);
  });

  it('never refills past capacity, however long the quiet spell', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const bucket = limiter();
    await bucket.take(CAPACITY, REFILL_SECONDS);

    vi.setSystemTime(24 * 3600 * 1000);

    for (let i = 0; i < CAPACITY; i++) {
      expect((await bucket.take(CAPACITY, REFILL_SECONDS)).ok).toBe(true);
    }
    expect((await bucket.take(CAPACITY, REFILL_SECONDS)).ok).toBe(false);
  });

  it('counts each client on its own bucket', async () => {
    vi.useFakeTimers();
    const first = limiter();
    const second = limiter();

    for (let i = 0; i < CAPACITY; i++) {
      await first.take(CAPACITY, REFILL_SECONDS);
    }
    expect((await first.take(CAPACITY, REFILL_SECONDS)).ok).toBe(false);

    expect((await second.take(CAPACITY, REFILL_SECONDS)).ok).toBe(true);
  });

  it('picks the count back up from storage after an eviction', async () => {
    vi.useFakeTimers();
    const backing = fakeState();

    const before = limiter(backing);
    for (let i = 0; i < CAPACITY; i++) {
      await before.take(CAPACITY, REFILL_SECONDS);
    }

    // A fresh object over the same storage, as after a DO restart.
    const after = limiter(fakeState(backing.stored));
    expect((await after.take(CAPACITY, REFILL_SECONDS)).ok).toBe(false);
  });
});

describe('callerKey', () => {
  it('keys on the connecting ip', () => {
    const request = new Request('https://broker.test/', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });

    expect(callerKey(request)).toBe('203.0.113.7');
  });

  it('falls back to one shared key when the ip header is absent', () => {
    expect(callerKey(new Request('https://broker.test/'))).toBe('unknown');
  });
});
