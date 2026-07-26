# Deploying heddle-server as a public playground

This describes how to run `heddle-server --allow-request-code` where anyone can
reach it. It is a different problem from running the server for yourself, and
most of it is about what surrounds the process rather than the process itself.

> **Running a trusted, multi-run service instead?** With
> `--allow-request-code` *off*, none of the one-container-per-run architecture
> below applies: a pod can serve many concurrent runs and scale normally. See
> [`k8s/`](./k8s/) for that topology. Everything here is specifically about
> accepting code from callers you do not trust.

## What you are actually deploying

With `--allow-request-code`, a request carries two kinds of code.

**Tool scripts** are written to a per-run directory and executed as
subprocesses. `--safe` confines them: no `$HOME`, no writes outside the run
workspace, and only the environment variables named by `--allow-env`.

**Plugin modules** are imported into the server's own Node process. heddle
loads a plugin with a dynamic `import()`, and compiling a flow calls the
plugin's `createExecutor`. So a submitted plugin runs as heddle, with heddle's
filesystem access and heddle's environment — every API key the process was
started with. `--safe` does not touch this, and nothing in `@heddle/server`
can: by the time the module is imported, it is the same program.

The consequence is the thing to design around:

> The confinement boundary is the process, not the sandbox. A server that
> accepts request code must be treated as already compromised, and must not
> outlive a single run.

Everything below follows from that.

## The shape

```
Browser (heddle.run/playground — static)
        │  HTTPS, CORS
        ▼
Broker  (public, authenticated, rate limited, holds no model keys)
        │  starts one container, proxies the SSE stream, destroys it
        ▼
heddle-server  (--allow-request-code, one container, one run, then gone)
```

The broker is the only thing on the public network. It is a small service: take
a request, start a container, pipe the stream back, tear the container down
whichever way the run ended. It is deliberately not part of this package —
what it should authenticate against, and what it should cost, are yours.

## Container runtime flags

The image in `Dockerfile` sets the server's own flags. These are the runtime's,
and they are the ones doing the work:

```bash
docker run --rm \
  --network heddle-egress \
  --read-only \
  --tmpfs /var/heddle/runs:rw,noexec,nosuid,size=64m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --memory 512m --memory-swap 512m \
  --cpus 1 \
  heddle-server
```

| Flag | Why |
|---|---|
| `--rm` | The container is the boundary; it must not survive the run. |
| `--read-only` | Submitted code cannot modify the image it runs from. |
| `--tmpfs …:noexec` on `/tmp` | Denies the obvious drop-and-run path. Note the run directory is *not* `noexec` — tool scripts are executed from there by design. |
| `--cap-drop ALL` | Nothing here needs a capability. |
| `--no-new-privileges` | Closes setuid escalation. |
| `--pids-limit` | A fork bomb is three characters of shell. |
| `--memory`, `--cpus` | Bound what one submission can consume. |

`--pids-limit` and the memory cap matter more than they look: without them the
cheapest attack on this service is not an escape, it is `:(){ :|:& };:`.

### Bubblewrap needs user namespaces

`--safe --sandbox bubblewrap` uses unprivileged user namespaces. Under Docker's
default seccomp profile `unshare` is blocked, so bwrap cannot start and every
tool call fails. Either allow it:

```bash
--security-opt seccomp=unconfined   # weakens the outer boundary — see below
```

or drop `--safe` from the image's `CMD` and rely on the container alone.

The second is usually the better trade. Tool sandboxing inside a
single-use container buys you little, and `seccomp=unconfined` gives up a real
protection to get it. On a runtime with stronger isolation — gVisor, Kata,
Firecracker — drop `--safe` and let the sandbox be the sandbox.

## Egress

A submitted tool or plugin can open sockets. Left alone, your playground is an
open proxy, and it can reach anything your network can — including cloud
metadata endpoints.

Put the container on a network that permits only what a run legitimately needs:

- **Deny** `169.254.169.254` and the rest of link-local. On a cloud host this
  is the credential endpoint, and it is one HTTP GET away from your instance
  role.
- **Deny** RFC1918 ranges and anything else internal.
- **Allow** the model API host, and nothing else.
- **Deny** inbound from anywhere except the broker.

Alternatively, `--deny-net` blocks the network for sandboxed tools entirely.
It does not restrict plugins, which run in the server process.

## Keys

Do not put a model API key in the container. A plugin can read `process.env`,
and there is no arrangement of flags that stops it.

Two workable options:

1. **A key with no value to steal.** A dedicated playground key, hard spend cap,
   rotated often, and useful for nothing else.
2. **No key in the container at all.** Point the server at an egress proxy that
   injects the credential and enforces the quota. Submitted code can then send
   requests through the proxy but never holds anything reusable.

The second is the right answer for anything you would leave running.

## Server flags

The `CMD` in the image is a starting point:

| Flag | Value | Why |
|---|---|---|
| `--allow-request-code` | on | The point of the playground. |
| `--max-concurrent` | `1` | One container, one run. Parallelism belongs to the broker. |
| `--timeout` | `60000` | Bound the run; the container is destroyed regardless. |
| `--max-iterations` | `25` | Stops a flow looping until the timeout. |
| `--work-dir` | `/var/heddle/runs` | Kept off `/tmp`, which bubblewrap remounts. |
| `--cors-origin` | your site | Only affects browsers. Not a control on anyone else. |

Add `--cors-origin https://heddle.run` for the deployed site. Use an exact
origin, not `*`, so a hostile page cannot drive the service with a visitor's
network position.

## What this does not give you

Worth being explicit, because a playground invites exactly this traffic:

- **No authentication.** The broker provides it, or nothing does.
- **No protection against a container escape.** A kernel bug in a namespace is
  a host compromise. Run the pool somewhere you can afford to lose, on its own
  project or account, with no access to anything else you own.
- **No content filtering.** Submitted code can compute anything computable.
- **No accounting.** Model spend is the broker's problem to meter.

## Checklist

- [ ] Broker terminates auth and rate limiting; the engine is never public
- [ ] One container per run, `--rm`, destroyed on every exit path
- [ ] `--read-only`, `--cap-drop ALL`, `--no-new-privileges`
- [ ] `--pids-limit`, `--memory`, `--cpus` set
- [ ] Egress restricted to the model endpoint; metadata IP denied
- [ ] No reusable credential inside the container
- [ ] `--cors-origin` naming an exact origin
- [ ] Container pool isolated from every other system you run
