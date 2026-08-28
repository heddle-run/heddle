/**
 * Where a submitted spec may send heddle's own requests.
 *
 * A model's `url` becomes the model client's base URL and heddle connects to
 * it. That is the point of the field when the spec is yours, and a different
 * thing entirely when it arrived in an HTTP request — then a stranger is
 * choosing where this process makes outbound connections *from inside your
 * network*.
 *
 * Two halves are pinned here, and the second matters as much as the first: what
 * the policy refuses, and what it does not. A control that overstates itself is
 * worse than none, because somebody will rely on it.
 */
import { describe, it, expect } from 'vitest';
import {
  assertEgressAllowed,
  isPrivateHost,
  redirectRefusingFetch,
} from '../egress.js';
import { createProvider } from '../provider.js';
import type { ModelSpec } from '../../spec/types.js';

const submitted = { allow: [] as string[] };
const where = 'models.x';

describe('the addresses nobody enumerates', () => {
  it.each([
    ['169.254.169.254', 'cloud instance credentials'],
    ['127.0.0.1', "this server's own unauthenticated API"],
    ['localhost', 'the same, by name'],
    ['10.0.0.5', 'RFC1918'],
    ['172.16.0.1', 'RFC1918'],
    ['172.31.255.255', 'RFC1918, top of the range'],
    ['192.168.1.1', 'RFC1918'],
    ['0.0.0.0', 'this host'],
    ['[::1]', 'IPv6 loopback'],
    ['[fe80::1]', 'IPv6 link-local'],
    ['[fd00::1]', 'IPv6 unique-local'],
    // The root label. WHATWG URL keeps it on a *name* while stripping it from an
    // IPv4 literal, so before this was normalised every entry in the name set
    // was one character away from being bypassed — and `localhost.` resolves to
    // loopback exactly as `localhost` does, with no attacker DNS involved.
    ['localhost.', 'the root label, which does not change what it resolves to'],
    ['LOCALHOST.', 'the same, uppercased'],
    ['foo.localhost.', 'a subdomain of it'],
  ])('refuses %s (%s)', (host) => {
    expect(() =>
      assertEgressAllowed(`http://${host}:8080/v1`, submitted, where),
    ).toThrow(/loopback, link-local or private/);
  });

  it('names the host and how to allow it', () => {
    expect(() =>
      assertEgressAllowed('http://169.254.169.254/latest/meta-data/', submitted, where),
    ).toThrow(/--allow-net 169\.254\.169\.254/);
  });
});

describe('what stays reachable', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'http://11.0.0.1',
    'http://193.168.1.1',
  ])('allows %s', (url) => {
    expect(() => assertEgressAllowed(url, submitted, where)).not.toThrow();
  });

  it('matches an allowed host however the spec spelled it', () => {
    // Otherwise the hole an operator punched would depend on a trailing dot.
    expect(() =>
      assertEgressAllowed('http://10.0.0.5./v1', { allow: ['10.0.0.5'] }, where),
    ).not.toThrow();
  });

  it('allows a private host the operator named', () => {
    expect(() =>
      assertEgressAllowed('http://10.0.0.5:8000/v1', { allow: ['10.0.0.5'] }, where),
    ).not.toThrow();
  });

  it('allows everything when there is no policy at all', () => {
    // The CLI running your own spec on your own machine. Refusing
    // http://localhost:11434 there would break every Ollama user for no gain,
    // because you wrote the spec.
    expect(() =>
      assertEgressAllowed('http://localhost:11434/v1', undefined, where),
    ).not.toThrow();
  });
});

describe('what this does not do', () => {
  it('does not resolve DNS, so a name pointing inward gets through', () => {
    // The honest boundary. Closing this needs the resolved address checked and
    // then *pinned* for the connection, or the check is a different question
    // from the connection — the name can resolve differently the second time.
    // That is a socket-level change and this is not it.
    expect(() =>
      assertEgressAllowed('http://metadata.google.internal/', submitted, where),
    ).not.toThrow();
    expect(isPrivateHost('metadata.google.internal')).toBe(false);
  });

  it('refuses a URL it cannot parse rather than passing it on', () => {
    expect(() => assertEgressAllowed('not a url', submitted, where)).toThrow(
      /not a URL/,
    );
  });
});

describe('at the provider', () => {
  const config = (url: string): ModelSpec => ({
    provider: 'openai-compatible',
    model: 'm',
    url,
    api_key: 'k',
    extra: {},
  });

  it('refuses before the URL becomes a connection', () => {
    expect(() =>
      createProvider(config('http://169.254.169.254/v1'), { egress: submitted }),
    ).toThrow(/private address/);
  });

  it('builds normally for a public endpoint', () => {
    expect(() =>
      createProvider(config('https://api.together.xyz/v1'), { egress: submitted }),
    ).not.toThrow();
  });

  it('is off unless a policy is supplied', () => {
    // Every existing caller passes no `egress`, so nothing that worked before
    // this landed behaves differently.
    expect(() => createProvider(config('http://localhost:11434/v1'), {})).not.toThrow();
  });
});

describe('the address checked and the address connected to', () => {
  it('refuses a redirect under a policy', async () => {
    // The check runs once, at construction, against the base URL — so on its own
    // it guarantees only that the *first* address was allowed. An allowed host
    // answering 302 Location: http://127.0.0.1/ would move the request somewhere
    // the policy already refused, and a 302 turns the POST into a GET, which is
    // the shape a metadata service wants.
    const redirecting = redirectRefusingFetch('models.x') as unknown as (
      input: string,
      init?: RequestInit,
    ) => Promise<Response>;

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/latest/meta-data/' },
      })) as typeof fetch;

    try {
      await expect(redirecting('https://allowed.example/v1')).rejects.toThrow(
        /does not follow redirects/,
      );
      await expect(redirecting('https://allowed.example/v1')).rejects.toThrow(
        /127\.0\.0\.1/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('passes an ordinary response through untouched', async () => {
    const redirecting = redirectRefusingFetch('models.x') as unknown as (
      input: string,
    ) => Promise<Response>;

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"ok":true}', { status: 200 })) as typeof fetch;

    try {
      const res = await redirecting('https://allowed.example/v1');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}');
    } finally {
      globalThis.fetch = original;
    }
  });
});
