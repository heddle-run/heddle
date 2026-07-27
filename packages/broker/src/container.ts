import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

/** Header the broker uses to hand a run its proxy credential. */
export const RUN_TOKEN_HEADER = "x-heddle-run-token";

/**
 * One heddle engine, for one run.
 *
 * Instances are addressed by run id, so each run gets a container that has
 * never executed anyone else's code and is reaped shortly after. That costs a
 * cold start per run.
 *
 * It used to buy the isolation the engine could not provide itself: submitted
 * plugins were `import()`ed into the server process, and node's ESM registry
 * has no unload, so a reused instance kept the previous caller's module
 * resident for the next. That is no longer true — plugins run in their own
 * process with an empty environment and are killed when the run ends. The
 * reason instances are still not reused is narrower, and it is the tools:
 * there is no bubblewrap on this platform and the engine runs without
 * `--safe`, so a submitted tool script is an ordinary process with the service
 * account's view of the filesystem. Its own run directory is removed
 * afterwards; anything it wrote elsewhere is not, and on a warm instance that
 * is left where the next caller's code runs.
 *
 * Two things make the container more than a process boundary:
 *
 * `enableInternet = false` with an allow list. The engine resolves an LLM's
 * base URL and credential from the *submitted spec*, so a flow can name any
 * endpoint and dereference any environment variable — no plugin needed. With
 * egress denied except to the broker, that flow reaches nothing: the request
 * to the attacker's host does not leave.
 *
 * A per-run credential. The container never holds the model key. It gets a
 * signed token, minted for this run and expiring in minutes, which the broker's
 * proxy exchanges for the real one. Extracting it from the environment is easy
 * and worth nothing — it only works against a proxy that counts its use, from
 * inside a container that can only reach that proxy. Note that this is a second
 * thing warm instances would break rather than merely slow: `startOptions` are
 * applied only on a start, so a reused instance would serve the next run under
 * the previous run's token and against its budget.
 */
export class HeddleEngine extends Container<Env> {
  defaultPort = 4319;

  /**
   * Short: the instance exists for one run, and the broker destroys it when
   * the response stream closes. This is the backstop for runs that end in a
   * way the broker does not see.
   */
  sleepAfter = "2m";

  /** Denied by default; the allow list applied below is the only way out. */
  enableInternet = false;

  /**
   * Start the engine for this run, then hand it the request.
   *
   * Both the allow list and the environment are set here rather than on the
   * class: the token is specific to this run, the broker's hostname is
   * configuration, and neither is known until a request arrives. Applied
   * before `startAndWaitForPorts`, so the container has never been running
   * without them.
   */
  override async fetch(request: Request): Promise<Response> {
    const token = request.headers.get(RUN_TOKEN_HEADER) ?? "";

    // Configured rather than hardcoded: the hostname differs between the
    // deployed worker and `wrangler dev`.
    this.allowedHosts = this.env.PROXY_HOST ? [this.env.PROXY_HOST] : [];

    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          // The OpenAI SDK reads both of these when a spec does not override
          // them, so an ordinary flow — no url, no api_key — is routed through
          // the broker and authenticated by it. A spec that *does* set `url`
          // is not a hole: egress denies everything but PROXY_HOST.
          OPENAI_BASE_URL: this.env.PROXY_URL,
          OPENAI_API_KEY: token,
        },
        labels: { component: "heddle-engine" },
      },
      cancellationOptions: {
        // A cold start that has not produced a listening port in this long is
        // not going to, and the caller should get an error rather than wait
        // out the request timeout.
        instanceGetTimeoutMS: 15_000,
        portReadyTimeoutMS: 20_000,
      },
    });

    // The token stops at the boundary: the engine authenticates to the proxy
    // through the environment, and the header would just be another copy of a
    // credential sitting somewhere submitted code can read.
    const forwarded = new Request(request);
    forwarded.headers.delete(RUN_TOKEN_HEADER);

    return this.containerFetch(forwarded);
  }

  override onError(error: unknown): unknown {
    // Surfaced to the broker, which turns it into a 502. Logged here because
    // the broker only sees the rejection, not which instance produced it.
    console.error("heddle engine container error", error);
    return error;
  }
}
