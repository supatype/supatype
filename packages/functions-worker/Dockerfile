# Pin matches packages/cli/releases/deno/VERSION (CDN mirror uses the same).
FROM denoland/deno:debian-2.2.0

WORKDIR /app
COPY --chmod=0644 LICENSE /LICENSE
# Every .ts beside main.ts, not a list of them.
#
# `COPY deno.json main.ts ./` left out the modules main.ts imports, so the image exited at once
# with `Module not found "file:///app/invocation.ts"` and the gateway answered 502 on every
# invocation. #10 fixed that by naming invocation.ts and logging.ts explicitly, which works today
# and breaks again the next time this file is split: naming the modules is the same mistake with a
# longer list, and the split is what caused it the first time.
COPY deno.json *.ts ./

# The assertion, next to the thing it asserts.
#
# A missing module now fails the image build, on every runner that builds it, release included.
# Without it the only thing standing between a broken COPY and a shipped image is a live-stack job
# that runs on dispatch and schedule only, and the failure surfaces as a container that exits at
# start with the gateway answering 502. That is how the broken image reached the registry.
RUN deno check main.ts

ENV PORT=8001
EXPOSE 8001

# What a function may read, and nothing else.
#
# A bare --allow-read let any handler, and any package it imports, read the whole container
# filesystem: /etc, the process table, and on a cluster the pod's service-account token. These are
# the only directories this image is run with:
#   /app                    the worker itself.
#   /project                self-host compose and `supatype dev` mount the project here, read-only:
#                           functions, hooks, shared modules, .env.local and .supatype/*.json.
#   /functions and /hooks   where Supatype Cloud mounts them.
# Deno reads its own module and npm caches without this permission. A deployment that mounts source
# anywhere else sets its own --allow-read (see tests/read-scope.test.ts).
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/app,/project,/functions,/hooks", "main.ts"]
