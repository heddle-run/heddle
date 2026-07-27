# heddle, the CLI, as a container.
#
# The point of this image is a flow that runs without installing Node, pnpm or
# a tool interpreter first:
#
#   docker run --rm -e OPENAI_API_KEY -v "$PWD:/work" heddle/heddle \
#     run flow.json --tools-dir tools --input '{"query": "hello"}'
#
# /work is the working directory, and the only place the image expects to find
# anything of yours. Mount your project there and the paths on the command line
# stay the ones you would have typed outside the container.
#
# This is the CLI, not the server. `heddle-server` has its own image, built
# from packages/server/Dockerfile, because the two are shaped by different
# questions: what a server exposes to callers, and what a CLI can reach on the
# machine that invoked it.
#
# Build from the repository root:
#   docker build -t heddle/heddle .

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
# Pinned to the *build* platform rather than the target. Everything this stage
# produces is JavaScript, and the runtime dependency tree — openai, commander,
# ink, react, yaml — contains no native code, so an arm64 image assembled from
# an amd64 build is the same artifact as one built under emulation, minus the
# emulation. Adding a production dependency with a compiled binary would
# invalidate that; check before you do.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build

WORKDIR /build

RUN corepack enable

# Manifests first, so a source-only change does not re-resolve the lockfile.
# The server's is here for symmetry with packages/server/Dockerfile and costs
# nothing — its devDependencies are already core's. packages/broker is the one
# member left out on purpose: nothing here builds a Worker, and its wrangler
# toolchain is larger than everything else in this stage put together. A
# workspace member absent from the context is simply not an importer, which
# --frozen-lockfile accepts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY vendor/agentspec/package.json ./vendor/agentspec/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/

# --ignore-scripts: the root `prepare` script builds the vendored SDK, which
# needs sources that have not been copied yet. It is run explicitly below.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY vendor/agentspec ./vendor/agentspec
COPY packages/core ./packages/core
COPY packages/cli ./packages/cli

RUN pnpm run build:vendor \
 && pnpm --filter @heddle/core build \
 && pnpm --filter @heddle/cli build

# Strip out everything that is not needed to run: dev dependencies, the
# TypeScript sources, and the workspace machinery around them. What is left is
# the CLI's dist and the packages it resolves at runtime.
RUN pnpm --filter @heddle/cli --prod deploy --legacy /runtime

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# python3 is here because heddle's tools are executables, not modules, and the
# documented shape of one is a Python or shell script reading JSON on stdin.
# An image that can run `heddle` but not the tools in its own examples/
# directory would be a CLI you still have to build an image around.
#
# bubblewrap backs --safe. Inside a container it is defence in depth rather
# than the boundary — the container is that — but a tool confined to its own
# workspace still cannot read the mount your flow came in on. It needs
# unprivileged user namespaces, which not every host grants; see
# docs/docker.md for what to do when it is refused.
RUN apt-get update \
 && apt-get install --no-install-recommends -y bubblewrap ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=root:root /runtime /app

# On PATH under its own name, so `--entrypoint` and `docker exec` reach the
# same binary the entrypoint does. tsup writes the shebang but not the mode.
RUN chmod 0755 /app/dist/heddle.js \
 && ln -s /app/dist/heddle.js /usr/local/bin/heddle

# The examples, so there is something to run before you have written anything:
#
#   docker run --rm -e OPENAI_API_KEY heddle/heddle run \
#     /opt/heddle/examples/research-assistant/flow.json \
#     --tools-dir /opt/heddle/examples/research-assistant/tools \
#     --input '{"query": "what is a heddle"}'
#
# Root-owned and read-only: they are reference material, and a flow that
# rewrites them would be editing the image rather than a project.
COPY --chown=root:root examples /opt/heddle/examples

# Where your project goes. Created ahead of the mount so that `heddle init`
# and a flow's own output work in an unmounted container too, rather than
# failing on a root-owned directory.
RUN install -d -o node -g node -m 0755 /work

USER node
WORKDIR /work

# HOME is stated rather than inherited from /etc/passwd: chat mode writes its
# transcripts to ~/.heddle/conversations, and a documented path to mount a
# volume at should not depend on how a runtime resolves the user.
ENV NODE_ENV=production \
    HOME=/home/node

LABEL org.opencontainers.image.title="heddle" \
      org.opencontainers.image.description="Run Open Agent Specification flows from the command line." \
      org.opencontainers.image.source="https://github.com/heddle-run/heddle" \
      org.opencontainers.image.url="https://heddle.run" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["node", "/app/dist/heddle.js"]

# No default subcommand: `docker run heddle/heddle` with nothing after it
# should describe the CLI, not start executing something.
CMD ["--help"]
