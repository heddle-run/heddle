# Deploying heddle-server as a public playground

This describes running `heddle-server --allow-request-code` where anyone can
reach it — a service that compiles and executes flows, tool scripts and plugins
written by its callers.

> **Trusted callers instead?** With `--allow-request-code` off, none of this is
> needed. See [`k8s/`](./k8s/).

## What confines what

Submitted code arrives in two kinds, and each is confined by something
specific. This used to be one blunt rule — a container per run — because
plugins ran inside the server process. They no longer do.

| | Mechanism | Confined by |
|---|---|---|
| **Tool scripts** | executed as subprocesses | `--safe`: no `$HOME`, no writes outside the run workspace, environment cut to what `--allow-env` names |
| **Plugin modules** | executed in their own process | own process, none of the server's environment, killed when the run ends |
| **The spec itself** | parsed as data | `$VAR` refused, so it cannot read this process's environment |

The consequence is the thing to design around, and it is the opposite of what
this document used to say:

> One long-lived process can serve many concurrent runs. Nothing a caller
> submits executes inside it, and nothing they submit outlives their request.

### Why plugins used to force one container per run

heddle loaded a plugin with a dynamic `import()`, so the plugin *was* the
server: same heap, same globals, same `process.env`. Three ordinary requests
were enough to exploit it — one plants a hook on a global, an unrelated run
passes through, the first reads back what the hook captured.

A submitted plugin now declares its shape in a manifest (data, so parsing
executes nothing) and ships handler source that runs in a separate process
speaking JSON-Lines over stdio. `packages/core/src/plugin/__tests__/remote.test.ts`
runs that exact attack and asserts it fails.

### Why `$VAR` is refused

`api_key: $ANYTHING` resolved against the server's environment, and was never
restricted to model credentials. Paired with a `url` the same spec chooses,
`api_key: $AWS_SECRET_ACCESS_KEY` read that variable and sent it to the
attacker's host. The "is not set" error made the environment enumerable on top
of that.

With `--allow-request-code`, the reference is refused, identically whether the
variable exists or not.

### `--tools-dir` is your public API

With `--allow-request-code` on, every executable in `--tools-dir` is something
you are offering your callers. A submitted flow can name one from a `ToolNode`,
and a submitted plugin granted `runTool` can name one too — with input of its
own choosing and without the flow mentioning it, since a plugin's reverse call
is checked against the tool registry and never against the spec.

So an executable you would not hand a caller directly does not belong in that
directory. There is no narrower grant available: a tool is either in the
registry or it is not.

## Credentials

**The server holds none.** A caller's spec carries its own key:

```yaml
llm_config:
  component_type: OpenAiConfig
  model_id: gpt-4o
  api_key: sk-the-callers-own-key
```

That is a better arrangement than an operator key behind a proxy — no shared
quota, no spend to meter, nothing to steal — but it moves an obligation onto
you, because a caller's credential now transits your infrastructure:

- **TLS is not optional.** The key is in the request body.
- **Do not log request bodies.** heddle does not; anything you put in front of
  it must not either. Check your ingress, your proxy and your APM agent.
- **Say so in the UI.** Someone pasting an API key into a web form deserves to
  be told where it goes.

The key is in the engine's memory for the duration of the run. Nothing
submitted can read it — plugins are out of process, tools get a stripped
environment — but a core dump or a heap snapshot would contain it.

## Egress is the remaining hole

A caller chooses the `url` their flow calls, and a tool can open sockets. Left
alone, the engine is an SSRF vector into whatever network it sits on, and an
open proxy out of it.

- **Deny `169.254.169.254`.** On a cloud host this is the instance metadata
  service, one HTTP GET from credentials for the whole account. Deny only that
  address — on OCI, `169.254.2.x` serves iSCSI boot volumes and blocking the
  range detaches the root disk.
- **Deny RFC1918 and anything else internal.**
- **Allow the public internet**, or an allow-list of model providers if you
  would rather constrain which ones work.

`--deny-net` blocks the network for sandboxed tools, but not for the engine's
own model calls, which are the point.

## Running it

```bash
docker run --rm \
  --read-only \
  --tmpfs /var/heddle/runs:rw,nosuid,size=64m,mode=1777 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 512 \
  --memory 2g --memory-swap 2g \
  --cpus 2 \
  heddle-server
```

| Flag | Why |
|---|---|
| `--read-only` | Submitted code cannot modify the image it runs from. |
| `mode=1777` on the run dir | The tmpfs shadows the image's directory; without a mode the server cannot create run directories at all. **Not `noexec`** — tool scripts are executed from there by design. |
| `noexec` on `/tmp` | Denies the obvious drop-and-run path. |
| `--cap-drop ALL` | Nothing here needs a capability. |
| `--pids-limit` | A fork bomb is three characters of shell. Size it above `--max-concurrent` × the processes a run can spawn. |
| `--memory`, `--cpus` | Bound the host's exposure to one busy period. |

`--pids-limit` and the memory cap matter more than they look: the cheapest
attack on this service is not an escape, it is `:(){ :|:& };:`.

### `--safe` needs a runtime that permits nested namespaces

`--safe --sandbox=bubblewrap` creates a user namespace and mounts `/proc` in
it. Under runc with a hardened security context that is denied — `bwrap: Can't
mount proc` — and dropping capabilities or relaxing seccomp does not change it.

Verified behaviour:

| Runtime | Security context | bubblewrap |
|---|---|---|
| rootless podman | any | fails |
| rootful runc | `cap-drop ALL`, no-new-privileges | fails |
| **gVisor (runsc)** | same | **works, and confines** |

gVisor implements namespaces and `/proc` in userspace and can afford to permit
them, because gVisor is itself the boundary. Under it, a confined tool sees an
empty `$HOME`, cannot write outside its workspace, and gets 6 environment
variables instead of the pod's.

So: run under gVisor and keep `--safe`, or run under runc and drop it. Asking
for `--safe` on runc fails every tool call.

gVisor needs `--security-opt label=disable` where SELinux is enforcing, and
`--platform=systrap` where `/dev/kvm` is absent.

## Server flags

| Flag | Suggested | Why |
|---|---|---|
| `--allow-request-code` | on | The point of the playground. |
| `--max-concurrent` | `8` | Runs share a process. Size it to what one instance holds with headroom. |
| `--timeout` | `60000` | Bounds a single run. |
| `--max-iterations` | `25` | Stops a flow looping until the timeout. |
| `--work-dir` | `/var/heddle/runs` | Off `/tmp`, which bubblewrap remounts. |
| `--cors-origin` | your site | Exact origin. Constrains browsers only. |
| `--drain-timeout` | `≥ --timeout` | So a run near its budget survives a rolling restart. |

## Deploying from CI

`.github/workflows/deploy-playground.yml` builds the image and rolls the host on
pushes to `main` that touch the engine. It deploys by SSH, because the host runs
`cloudflared` and has no inbound port open.

The division of responsibility is the part worth keeping: **the systemd unit owns
every flag in this document, and CI owns only which image `heddle-engine:latest`
resolves to.** A deploy pulls a commit-tagged image, retags it, and restarts the
unit. It cannot widen a memory cap or drop `--safe`, and a rollback is

```bash
sudo podman pull <registry>/heddle-engine:<older-sha>
sudo podman tag  <registry>/heddle-engine:<older-sha> localhost/heddle-engine:latest
sudo systemctl restart heddle-engine
```

The workflow verifies the running container's image ID against what it pushed,
so a failed pull that leaves the old image in place fails the deploy instead of
reading as a green one.

### One-time host setup

The host holds its own pull credential, the same way it already holds the model
key in `/etc/heddle/llm.env`. A registry token passed over `ssh` would sit in the
remote process's argv, readable by anything that got as far as running `ps` — on
a box whose whole design assumes callers are hostile.

```bash
# On the host, as root. Username is <namespace>/<user>, or
# <namespace>/<domain>/<user> with identity domains. The password is an OCI
# auth token, not the console password.
sudo podman login <region>.ocir.io
```

Then add a deploy key for CI — its own keypair, not a person's:

```bash
# On the host
sudo -u opc tee -a ~opc/.ssh/authorized_keys < deploy-key.pub
```

The build runs on an `aarch64` runner to match the host's Ampere shape. An x86
runner would need qemu, and one wrong `--platform` produces an image the host
cannot execute.

### Repository configuration

| | Name | What |
|---|---|---|
| Variable | `OCIR_REGION` | e.g. `us-sanjose-1` — the host's own region, so pulls stay in the datacentre |
| Variable | `OCIR_NAMESPACE` | the tenancy's object storage namespace (`oci os ns get`) |
| Variable | `HEDDLE_API_URL` | the engine's public URL, for the post-deploy check |
| Secret | `OCIR_USERNAME` | `<namespace>/<user>` |
| Secret | `OCIR_TOKEN` | an OCI auth token |
| Secret | `PLAYGROUND_SSH_KEY` | the deploy key's private half |
| Secret | `PLAYGROUND_SSH_HOST` | the host's address — a secret, not a variable, because this repository is public and Cloudflare proxies the origin precisely so its address is not published |
| Secret | `PLAYGROUND_SSH_KNOWN_HOSTS` | the host's public keys, pinned. `ssh-keyscan` at deploy time would accept whatever answers on the address, which is the attack a host key exists to detect |

## What this still does not give you

- **No authentication.** Terminate it in front — the engine has none by design.
- **No rate limiting.** Same.
- **No accounting.** Callers spend their own model credit, so there is nothing
  to meter, but compute is still yours.
- **No protection against a container escape.** Run this where you can afford
  to lose it, on its own account, with no access to anything else you own.

## Checklist

- [ ] Auth and rate limiting terminated in front; the engine never public
- [ ] TLS, and nothing in the request path logs bodies
- [ ] `--read-only`, `--cap-drop ALL`, `--no-new-privileges`
- [ ] `--pids-limit`, `--memory`, `--cpus` set
- [ ] Run dir tmpfs is `mode=1777` and **not** `noexec`
- [ ] `--safe` only under gVisor or another runtime that permits nested userns
- [ ] Metadata IP denied; internal ranges denied
- [ ] No credential in the engine's environment — callers bring their own
- [ ] `--cors-origin` naming an exact origin
