/**
 * Where a submitted spec may send heddle's own requests.
 *
 * A flow chooses its endpoint: `llm_config.url` becomes the model client's base
 * URL, and heddle connects to it. That is the point of the field when the spec
 * is yours. It is a different thing entirely when the spec arrived in an HTTP
 * request, because then a stranger is choosing where this process makes outbound
 * connections *from inside your network*.
 *
 * The addresses that matter are the ones nobody enumerates. `169.254.169.254` is
 * instance credentials on every major cloud; `127.0.0.1` is this server's own
 * unauthenticated `/v1/runs`; the RFC1918 ranges are whatever else the operator
 * runs. Those are the standard SSRF targets, and a spec naming one is asking
 * heddle to fetch it with heddle's own network position.
 *
 * **So the deny list inverts for one band, and only one.** The public internet
 * stays reachable, because a flow calling a model API is the ordinary case and
 * an allowlist of the internet is not a list. The private bands are refused
 * unless an operator names them, because that is the case where "not enumerated"
 * and "not intended" are the same thing.
 *
 * ---
 *
 * **What this does not do, stated because a security control that overstates
 * itself is worse than none.**
 *
 * It reads the address the spec wrote. It does **not** resolve DNS, so a
 * hostname that resolves into a private range — `metadata.google.internal`, or
 * any name an attacker controls and points at `127.0.0.1` — is not caught here.
 * Closing that needs the resolved address checked and then *pinned* for the
 * connection, or the check is a different question from the connection (the name
 * can resolve differently the second time). That is a socket-level change, and
 * this is not it.
 *
 * It also says nothing about what a *tool* or an out-of-process *plugin* reaches.
 * Those make their own connections through their own runtimes and heddle never
 * sees them; the sandbox's `network` switch is all-or-nothing because neither
 * backend can filter by address. See `sandbox/types.ts`.
 *
 * What it does close is the direct case: a submitted spec naming a private
 * address outright. Real containment is a network-level egress rule, and this
 * does not replace one.
 */
import { LLMError } from '../errors.js';

/** What a submitted spec may reach. */
export interface EgressPolicy {
  /**
   * Hosts the operator has decided are reachable anyway, matched against the
   * URL's hostname exactly.
   *
   * The hole-punch for the ordinary reason a private address is legitimate: a
   * model server on the operator's own network. Naming one is a decision
   * somebody made, which is the whole difference from the default.
   */
  allow: string[];
}

/**
 * A `fetch` that refuses to be redirected, for use under a policy.
 *
 * The policy is checked once, against the base URL, before any connection is
 * made — so on its own it guarantees only that the *first* address was
 * allowed. `fetch` defaults to `redirect: 'follow'`, and the OpenAI SDK passes
 * no option, so an allowed host answering `302 Location: http://127.0.0.1/`
 * moves the request somewhere the policy already refused. The address checked
 * would not be the address connected to.
 *
 * Worse than blind, in two specific ways. Per the fetch spec a 302 turns a POST
 * into a GET, which is exactly the shape a metadata service wants — the model
 * call is a POST to `/chat/completions` and would arrive as a GET. And the
 * response comes back through `asLLMError`, whose message for a non-JSON body
 * is the body, which the server then returns in its error payload. So the
 * redirect would not merely reach the internal service; it would hand the
 * caller what it said.
 *
 * Refused rather than re-checked and followed. Re-checking the `Location` would
 * work for one hop and invite the same question at the next, and no model API
 * needs a redirect to serve a completion.
 *
 * Installed **only when a policy is in force**, so the ordinary local case —
 * no policy, your own spec, your own machine — keeps the SDK's own behaviour.
 */
export function redirectRefusingFetch(where: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location') ?? '(unstated)';
    throw new LLMError(
      `${where} was redirected to "${location}". heddle does not follow ` +
        `redirects for a spec it did not write: the address it checked would not ` +
        `be the address it connected to, and a redirect is how an allowed host ` +
        `reaches one that is not.`,
    );
  };
}

/** Host names that are local whatever they resolve to. */
const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/**
 * IPv4 ranges refused by default, as [first octet, predicate].
 *
 * Written as arithmetic rather than as CIDR strings because there are six of
 * them and a CIDR parser would be more code than the rules it parses.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = octets;
  return (
    a === 0 || // this host
    a === 127 || // loopback
    a === 10 || // RFC1918
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) // link-local, including cloud metadata
  );
}

/** IPv6 forms that are loopback, link-local or unique-local. */
function isPrivateIpv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (address === '::1' || address === '::') return true;

  // fe80::/10 link-local, fc00::/7 unique-local.
  return /^fe[89ab]/.test(address) || /^f[cd]/.test(address);
}

/** Whether a hostname is one the default policy refuses. */
export function isPrivateHost(host: string): boolean {
  // The root label is stripped first, because WHATWG URL keeps it on a *name*
  // while removing it from an IPv4 literal — `127.0.0.1.` normalises and
  // `localhost.` does not. Without this, every name below is one character away
  // from being bypassed, and `localhost.` resolves to loopback exactly as
  // `localhost` does.
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    LOCAL_NAMES.has(name) ||
    name.endsWith('.localhost') ||
    isPrivateIpv4(name) ||
    isPrivateIpv6(name)
  );
}

/**
 * Refuse a URL a submitted spec chose, if it names somewhere it should not.
 *
 * `policy` absent means no restriction, which is the CLI running your own spec
 * on your own machine — where `http://localhost:11434` is an Ollama server and
 * refusing it would break the ordinary local case for no gain. The policy exists
 * where the spec's author and the operator are different people.
 */
export function assertEgressAllowed(
  url: string,
  policy: EgressPolicy | undefined,
  where: string,
): void {
  if (!policy) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LLMError(
      `${where} names "${url}", which is not a URL heddle can parse.`,
    );
  }

  // Normalised the same way `isPrivateHost` normalises, so `--allow-net
  // 10.0.0.5` matches a spec that wrote `10.0.0.5.` — otherwise the hole an
  // operator punched would depend on how the spec spelled the host.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!isPrivateHost(host)) return;
  if (policy.allow.some((allowed) => allowed.toLowerCase().replace(/\.$/, '') === host)) {
    return;
  }

  throw new LLMError(
    `${where} points at "${host}", which is a loopback, link-local or private ` +
      `address. This heddle refuses those for a spec it did not write: they are ` +
      `where a cloud's instance credentials, this server's own API and the rest ` +
      `of the operator's network live, and a submitted spec naming one is asking ` +
      `heddle to fetch it from inside that network.\n` +
      `  If it is meant to be reachable, the operator allows it by name with ` +
      `--allow-net ${host}.`,
  );
}
