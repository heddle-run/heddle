import { describe, expect, it } from 'vitest';
import { allowedOrigin, corsHeaders, preflight, withCors } from '../cors';

const SITE = 'https://heddle.run';

function request(origin?: string, method = 'GET'): Request {
  return new Request('https://broker.test/v1/runs', {
    method,
    headers: origin === undefined ? {} : { origin },
  });
}

describe('allowedOrigin', () => {
  it('denies everything when no origins are configured', () => {
    expect(allowedOrigin(SITE, [])).toBeUndefined();
    expect(allowedOrigin(null, [])).toBeUndefined();
  });

  it('allows anyone when the wildcard is configured', () => {
    expect(allowedOrigin(SITE, ['*'])).toBe('*');
    expect(allowedOrigin(null, ['*'])).toBe('*');
  });

  it('denies a request that sent no origin', () => {
    expect(allowedOrigin(null, [SITE])).toBeUndefined();
  });

  it('allows a configured origin, and echoes it back', () => {
    expect(allowedOrigin(SITE, ['https://other.example', SITE])).toBe(SITE);
  });

  it('denies an origin that is not on the list', () => {
    expect(allowedOrigin('https://evil.example', [SITE])).toBeUndefined();
  });

  it('matches whole origins, never prefixes', () => {
    expect(
      allowedOrigin('https://heddle.run.evil.com', [SITE]),
    ).toBeUndefined();
    expect(allowedOrigin(`${SITE}.evil.com`, [SITE])).toBeUndefined();
    expect(allowedOrigin('https://heddle.ru', [SITE])).toBeUndefined();
  });
});

describe('corsHeaders', () => {
  it('emits nothing for a denied origin', () => {
    expect(corsHeaders(request('https://evil.example'), [SITE])).toEqual({});
  });

  it('scopes the grant to the one origin, and varies on it', () => {
    const headers = corsHeaders(request(SITE), [SITE]);

    expect(headers['access-control-allow-origin']).toBe(SITE);
    expect(headers.vary).toBe('Origin');
  });

  it('omits vary under the wildcard, where every answer is the same', () => {
    const headers = corsHeaders(request(SITE), ['*']);

    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers.vary).toBeUndefined();
  });
});

describe('preflight', () => {
  it('answers OPTIONS with 204 and the cors grant', () => {
    const response = preflight(request(SITE, 'OPTIONS'), [SITE]);

    expect(response?.status).toBe(204);
    expect(response?.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('leaves every other method to the router', () => {
    expect(preflight(request(SITE, 'POST'), [SITE])).toBeUndefined();
  });
});

describe('withCors', () => {
  it('adds the grant while keeping the response status and headers', async () => {
    const original = new Response('body', {
      status: 418,
      headers: { 'x-existing': 'kept' },
    });

    const decorated = withCors(original, {
      'access-control-allow-origin': SITE,
    });

    expect(decorated.status).toBe(418);
    expect(decorated.headers.get('x-existing')).toBe('kept');
    expect(decorated.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(await decorated.text()).toBe('body');
  });
});
