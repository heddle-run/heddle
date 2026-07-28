# heddle in a container

Two images, both for `linux/amd64` and `linux/arm64`:

| Image | Contains | Entrypoint |
|---|---|---|
| [`heddlerun/heddle`](https://hub.docker.com/r/heddlerun/heddle) | the CLI | `heddle` |
| [`heddlerun/heddle-server`](https://hub.docker.com/r/heddlerun/heddle-server) | the HTTP API | `heddle-server` |

Each is published to two registries from one build, with identical manifests:
Docker Hub under `heddlerun/`, and GitHub Container Registry under
`ghcr.io/heddle-run/`. Every command here works with either name.

```bash
docker pull heddlerun/heddle             # Docker Hub
docker pull ghcr.io/heddle-run/heddle    # GHCR
```

Reach for GHCR when Docker Hub's anonymous pull limit is in your way — CI that
pulls on every job is the usual case — or when you want the name to match the
repository, hyphen and all. Docker Hub cannot have the hyphen: an account name
there is alphanumeric.

Tags follow releases: `0.2.0` for a version, `0.2` for its line, `latest` for
the newest release. Prereleases publish their own version and nothing else, so
`latest` never becomes one. Every commit on `main` publishes `edge` and a
`sha-` tag alongside it — useful for reproducing a report, not for depending
on.

## Run a flow

```bash
docker run --rm \
  -e OPENAI_API_KEY \
  -v "$PWD:/work" \
  heddlerun/heddle run flow.json --tools-dir tools --input '{"query": "hello"}'
```

`/work` is the working directory, so paths on the command line are the ones you
would have typed outside the container. `-e OPENAI_API_KEY` with no value
forwards the variable from your shell; spelling it out as `-e
OPENAI_API_KEY=sk-...` puts the key in your shell history and in the process
list of everyone on the machine.

The final state goes to stdout as JSON and progress to stderr, exactly as it
does outside a container, so `| jq` works.

Nothing needs mounting to try one first — the examples are in the image:

```bash
docker run --rm -e OPENAI_API_KEY heddlerun/heddle run \
  /opt/heddle/examples/research-assistant/flow.json \
  --tools-dir /opt/heddle/examples/research-assistant/tools \
  --input '{"query": "what is a heddle"}'
```

Scaffolding writes into the mount:

```bash
docker run --rm -v "$PWD:/work" heddlerun/heddle init my-project
```

If typing that gets old:

```bash
alias heddle='docker run --rm -i -e OPENAI_API_KEY -v "$PWD:/work" heddlerun/heddle'
```

`-i` and not `-it`, deliberately. `-t` allocates a pty, and a pty is one
stream: the progress that belongs on stderr would arrive interleaved with the
JSON on stdout, and `| jq` would choke on it. Add `-t` for the one case that
needs it, below.

## Chat

Chat mode draws a terminal UI, which needs a TTY:

```bash
docker run --rm -it \
  -e OPENAI_API_KEY \
  -v "$PWD:/work" \
  heddlerun/heddle run flow.json --tools-dir tools --chat
```

Transcripts are written to `~/.heddle/conversations` inside the container and
leave with it. To keep them, give that directory a volume:

```bash
-v heddle-home:/home/node/.heddle
```

## Files and ownership

The container runs as the image's `node` user, uid 1000. On Linux that is
usually the first login account, so files written into a bind mount come out
owned by you. When it is not — a different uid, or a shared checkout — say so:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" heddlerun/heddle init my-project
```

A uid with no matching entry in the image's `/etc/passwd` has no home
directory it can write, which chat mode needs. Give it one:

```bash
-e HOME=/tmp
```

## Reaching a model

`OpenAiConfig` needs `OPENAI_API_KEY` in the container's environment; any
`api_key: $NAME` in a spec needs `NAME` there. Forward each with its own `-e`.
An `--env-file` works too, and keeps keys out of your shell history.

A local model is the case worth knowing about: inside the container,
`localhost` is the container. An `OllamaConfig` or `VllmConfig` pointing at
`http://localhost:11434` will find nothing. Either name the host explicitly —
`http://host.docker.internal:11434`, which needs
`--add-host host.docker.internal:host-gateway` on Linux — or run with
`--network host` and leave the URL alone.

Remember that a local server still needs a key that resolves, even though it
ignores the value. `-e OPENAI_API_KEY=unused` is enough.

## Tools

Tools are executables, so what matters is whether the image can run yours. It
has `bash`, `python3` and — being a Node image — `node`, which covers the
shapes in `examples/` and most of what people write. A tool in some other
language either has to be a self-contained binary you mount alongside it, or
needs an image of its own built `FROM heddlerun/heddle`:

```dockerfile
FROM heddlerun/heddle
USER root
RUN apt-get update \
 && apt-get install --no-install-recommends -y ruby \
 && rm -rf /var/lib/apt/lists/*
USER node
```

Without `--safe`, tools inherit the container's environment, API keys included.
That is the same warning as outside a container, with one difference worth the
image on its own: the outer bound on what a tool can reach is now your project
mount and whatever else you passed in, rather than your whole account.

## Safe mode

`--safe` works in the image — `bubblewrap` is installed — but it needs a host
that permits unprivileged user namespaces, and not every host does.
bubblewrap has to create one and mount `/proc` inside it; Docker's default
seccomp and AppArmor profiles allow that, while a hardened runtime or a
restrictive `securityContext` will not. The Kubernetes manifest in
[`packages/server/k8s`](../packages/server/k8s) is a worked example of the
second case. When it is refused, every tool call fails rather than quietly
running unconfined, which is deliberate: `--safe` never degrades into
something weaker without saying so.

If it is refused and you cannot change the host, drop `--safe`. Inside a
container it was defence in depth on top of a boundary you already have; run
without it and the container is what confines the tool, as it was going to be
anyway. Do not reach for `--privileged` to get it back — that trades the
boundary for the defence in depth.

## The server image

```bash
docker run --rm \
  -p 127.0.0.1:4319:4319 \
  -e OPENAI_API_KEY \
  -v "$PWD/tools:/srv/tools:ro" \
  heddlerun/heddle-server
```

Note `127.0.0.1:` in front of the port. **The server has no authentication**,
and every executable in `--tools-dir` is offered to anything that can reach it;
publishing the port on all interfaces puts a shell on your network. Read
[`packages/server/README.md`](../packages/server/README.md) before you widen
it, and [`DEPLOYMENT.md`](../packages/server/DEPLOYMENT.md) before you expose
it to callers you do not control.

The image's default command is deliberately narrower than the playground's: it
does not pass `--allow-request-code`, so a caller can run the flows you have
provisioned tools for, but cannot submit tool scripts or plugins of their own.
Turning that on means restating the command, because arguments after the image
name replace it rather than extend it:

```bash
docker run --rm -p 127.0.0.1:4319:4319 heddlerun/heddle-server \
  --host 0.0.0.0 --port 4319 \
  --allow-request-code \
  --work-dir /var/heddle/runs \
  --tools-dir /srv/tools \
  --safe --sandbox bubblewrap \
  --max-concurrent 8 --max-iterations 25 \
  --timeout 60000 --drain-timeout 90000
```

`--host 0.0.0.0` is in there because a container that binds loopback is a
container nothing can reach. What keeps it private is the `-p` binding and the
network the container is on, not the bind address.

## Building them yourself

Both build from the repository root; the server's Dockerfile reaches across to
`packages/core` and `vendor/agentspec`.

```bash
docker build -t heddlerun/heddle .
docker build -f packages/server/Dockerfile -t heddlerun/heddle-server .
```

Each builds its own stage on the native platform and copies the result into the
target's runtime stage, so a cross-platform build does not mean a TypeScript
build under emulation. That holds only while every production dependency is
pure JavaScript — it is today, and adding one with a compiled binary would end
it.

## Publishing

[`.github/workflows/docker.yml`](../.github/workflows/docker.yml) builds and
pushes both images on a `v*` tag and on every push to `main`. It runs
alongside `release.yml` rather than inside it: both take the tag as their
input, and neither should be able to hold up the other.

**GHCR needs no configuration.** It authenticates with the workflow's own
`GITHUB_TOKEN`, so that half publishes in a fresh checkout with nothing set up.
One manual step, once per image: a package pushed to GHCR starts private, and
`docker pull` from a logged-out machine will 404 until you open it at
`github.com/orgs/heddle-run/packages`, choose the package, and set its
visibility to public under Package settings.

**Docker Hub needs two secrets**, and takes an optional variable:

| | |
|---|---|
| `DOCKERHUB_USERNAME` | a Docker Hub account with push access to the namespace |
| `DOCKERHUB_TOKEN` | an access token for it, with Read & Write scope — not the account password |
| `DOCKERHUB_NAMESPACE` | variable, not secret; the account to publish under. Defaults to `heddlerun`. |

When they are absent the run does not fail — it publishes to GHCR and leaves a
notice saying Docker Hub was skipped, which is the state this repository is in
until someone sets them. Nothing needs creating on Docker Hub first: a push to
a repository that does not exist creates it, public unless your account's
default privacy says otherwise. Docker Hub does not take a description from the
image, so the summary and overview on each repository's page are set by hand.

A Docker Hub namespace is an account name, not something separate you create.
Whatever `DOCKERHUB_USERNAME` names is the namespace, so publishing as
`heddlerun/heddle` means the account itself is `heddlerun` — an organisation
if you have paid for one, a plain free account otherwise. The two are
indistinguishable to anyone pulling.
