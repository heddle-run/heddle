import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintToken, verifyToken } from '../token';

const SECRET = 'test-secret';
const TTL = 300;

afterEach(() => {
  vi.useRealTimers();
});

describe('run tokens', () => {
  it('round-trips: what was minted verifies, and names the run', async () => {
    const token = await mintToken(SECRET, 'run-42', TTL);
    const verified = await verifyToken(SECRET, token);

    expect(verified).toBeDefined();
    expect(verified!.runId).toBe('run-42');
  });

  it('carries an expiry a ttl away from now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    const token = await mintToken(SECRET, 'run-42', TTL);
    const verified = await verifyToken(SECRET, token);

    expect(verified!.expiresAt).toBe(1_700_000_000 + TTL);
  });

  it('refuses a token past its expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const token = await mintToken(SECRET, 'run-42', TTL);

    vi.setSystemTime(1_700_000_000_000 + (TTL + 1) * 1000);

    expect(await verifyToken(SECRET, token)).toBeUndefined();
  });

  it('still accepts a token just inside its expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const token = await mintToken(SECRET, 'run-42', TTL);

    vi.setSystemTime(1_700_000_000_000 + (TTL - 1) * 1000);

    expect(await verifyToken(SECRET, token)).toBeDefined();
  });

  it('refuses a token whose run id was tampered with', async () => {
    const token = await mintToken(SECRET, 'run-42', TTL);
    const [, expiry, signature] = token.split('.');

    expect(
      await verifyToken(SECRET, `run-43.${expiry}.${signature}`),
    ).toBeUndefined();
  });

  it('refuses a token whose expiry was tampered with', async () => {
    const token = await mintToken(SECRET, 'run-42', TTL);
    const [runId, expiry, signature] = token.split('.');
    const later = String(Number(expiry) + 3600);

    expect(
      await verifyToken(SECRET, `${runId}.${later}.${signature}`),
    ).toBeUndefined();
  });

  it('refuses a token minted under a different secret', async () => {
    const token = await mintToken('other-secret', 'run-42', TTL);

    expect(await verifyToken(SECRET, token)).toBeUndefined();
  });

  it('refuses malformed tokens instead of throwing', async () => {
    expect(await verifyToken(SECRET, '')).toBeUndefined();
    expect(await verifyToken(SECRET, 'just-one-field')).toBeUndefined();
    expect(await verifyToken(SECRET, 'two.fields')).toBeUndefined();
    expect(await verifyToken(SECRET, 'run.not-a-number.sig')).toBeUndefined();
    expect(await verifyToken(SECRET, 'a.1.b.c')).toBeUndefined();
  });
});
