# Pin matches packages/cli/releases/deno/VERSION (CDN mirror uses the same).
FROM denoland/deno:debian-2.2.0

WORKDIR /app
# Every .ts beside main.ts, not main.ts alone.
# main.ts imports ./invocation.ts and ./logging.ts, which this line used to leave out, so an
# image built from this Dockerfile exited at once with `Module not found "file:///app/invocation.ts"`.
# A glob rather than a list: the last split into modules broke this and the next one would too.
COPY deno.json *.ts ./

# The assertion, next to the thing it asserts.
# A missing module now fails the image build, on every runner that builds it, release included.
# Without it the only thing standing between a broken COPY and a shipped image is a live-stack job
# that runs on dispatch and schedule only, and the failure surfaces as a container that exits at
# start with the gateway answering 502.
RUN deno check main.ts

ENV PORT=8001
EXPOSE 8001

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
