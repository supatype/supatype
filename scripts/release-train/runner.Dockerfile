# The local release train's runner: a stand-in for a CI runner, with its own Docker daemon.
#
# The suites assume a machine of their own. They name compose projects after their examples
# (supatype-realtime, supatype-kitchen-sink, ...) and bind the default ports (18473, 54329), which
# on a developer's machine belong to stacks already running there. Inside this container they get
# a daemon and a port space of their own, as they do on a GitHub runner, and nothing outside it
# is touched. It needs `--privileged` to run that daemon.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq xz-utils unzip python3 iptables procps \
    docker.io docker-compose-v2 docker-buildx \
  && rm -rf /var/lib/apt/lists/*

# Node 22, as the workflows use, from the official tarball rather than a distribution package, and
# the pnpm the repository pins. pnpm comes from npm, not corepack: a corepack older than its
# signing-key rotation refuses to install pnpm at all.
ARG NODE_VERSION=22.23.3
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
  && npm install -g pnpm@10.6.0 >/dev/null

WORKDIR /work
# The daemon is the container's main process; the train runs through `docker exec`.
CMD ["dockerd", "--host=unix:///var/run/docker.sock"]
