# heddle-server, built for the playground.
#
# This image serves many concurrent runs. It did not always: plugins used to be
# imported into the server process, which made the process the only boundary
# and forced one container per run. They now execute in their own process with
# an empty environment, tool scripts are subprocesses confined by --safe, and a
# submitted spec cannot dereference this process's environment. Nothing a
# caller sends runs inside the server, and nothing outlives their request.
#
# The container is still a boundary worth having — see the runtime flags in
# packages/server/DEPLOYMENT.md, which are what bound a busy caller's effect on
# the host.
#
# Build from the repository root:
#   docker build -f packages/server/Dockerfile -t heddle-server .

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /build

RUN corepack enable

# Manifests first, so a source-only change does not re-resolve the lockfile.
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
COPY packages/server ./packages/server

RUN pnpm run build:vendor \
 && pnpm --filter @heddle/core build \
 && pnpm --filter @heddle/server build

# Strip out everything that is not needed to run: dev dependencies, sources,
# and the CLI, which the server never loads.
RUN pnpm --filter @heddle/server --prod deploy --legacy /runtime

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# bubblewrap confines tool subprocesses inside the container. It is defence in
# depth, not the boundary: it does nothing about plugin modules, which run in
# the server process. Kept because a tool that escapes into the container
# should still not be able to read the server's own files.
#
# python3 is here because a submitted tool may declare it as its interpreter —
# `python3` is one of the four the request schema accepts, and the base image
# ships node and bash but no Python, so that choice produced a tool that could
# not start. The engine's own code does not use it.
RUN apt-get update \
 && apt-get install --no-install-recommends -y bubblewrap python3 \
 && rm -rf /var/lib/apt/lists/*

# Per-run scratch, owned by the service account. Deliberately not under /tmp:
# bubblewrap mounts a fresh tmpfs there, and a tool materialized into a path
# that is then shadowed by a mount is harder to reason about than one that is
# not.
RUN install -d -o node -g node -m 0700 /var/heddle/runs \
 && install -d -o node -g node -m 0500 /srv/tools

COPY --from=build --chown=root:root /runtime /app

USER node
WORKDIR /app

ENV NODE_ENV=production

# Bound to all interfaces because the only thing that can reach this port is
# whatever the container runtime attaches to it. The loopback default exists to
# protect a developer's laptop; here it would just make the container
# unreachable from its own broker. The isolation comes from the network the
# container is placed on -- see DEPLOYMENT.md.
EXPOSE 4319

ENTRYPOINT ["node", "/app/dist/heddle-server.js"]

# --safe here assumes a runtime that permits nested user namespaces. Under runc
# with a hardened security context bubblewrap cannot mount /proc and every tool
# call fails; gVisor permits it and confines properly. Drop --safe and
# --sandbox if you are running under plain runc. See DEPLOYMENT.md.
#
# --max-concurrent is 8, not 1: runs no longer need a container each.
CMD ["--host", "0.0.0.0", \
     "--port", "4319", \
     "--allow-request-code", \
     "--work-dir", "/var/heddle/runs", \
     "--tools-dir", "/srv/tools", \
     "--safe", \
     "--sandbox", "bubblewrap", \
     "--max-concurrent", "8", \
     "--max-iterations", "25", \
     "--timeout", "60000", \
     "--drain-timeout", "90000"]
