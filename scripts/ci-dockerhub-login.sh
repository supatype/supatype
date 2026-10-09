#!/usr/bin/env bash
# Log CI in to Docker Hub so image pulls are not held to the anonymous per-IP rate limit.
#
# Reads DOCKERHUB_USERNAME and DOCKERHUB_TOKEN from the environment; workflows pass them through a
# step `env:` and skip the step when the username is empty (fork and Dependabot PRs get no
# secrets), so those runs pull anonymously. The mirror.gcr.io registry mirror, which serves most
# pulls without touching either rate limit, is set up before this by scripts/ci-docker-mirror.sh.
#
# The login is only there to lift the rate limit, so Docker Hub being unavailable must not fail
# the job: it has answered this login with a 500, and a job that then stops before any test has
# lost more than it would to anonymous pulls. Wrong credentials are different. They will not fix
# themselves, and continuing would hide them until the rate limit bites again, so they fail.
#
# Runs under the bash on ubuntu and macOS runners (3.2 on macOS: no ${var,,}, no mapfile).
set -uo pipefail

: "${DOCKERHUB_USERNAME:?DOCKERHUB_USERNAME is not set}"
: "${DOCKERHUB_TOKEN:?DOCKERHUB_TOKEN is not set}"

# One line for the log: the daemon's registry mirrors, and the hourly pull budget Docker Hub gives
# the CI account and how much of it is left. Every parallel job pulls from that one budget, and its
# exhaustion is reported by Docker Hub as an "unauthenticated pull rate limit" even when the pull
# was authenticated, so the number is worth having beside the failure. A HEAD of the rate-limit
# preview manifest is free. Prints no credential or token, and never fails the step.
summarize() {
  local scope="repository:ratelimitpreview/test:pull" token headers limit remaining
  token=$(printf 'user = "%s:%s"\n' "$DOCKERHUB_USERNAME" "$DOCKERHUB_TOKEN" \
    | curl -sS -K - --max-time 20 \
      "https://auth.docker.io/token?service=registry.docker.io&scope=$scope" 2>/dev/null \
    | python3 -c 'import json, sys; print(json.load(sys.stdin).get("token", ""))' 2>/dev/null) || token=""
  if [ -n "$token" ]; then
    # The token goes through curl's stdin config, not its command line.
    headers=$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
      | curl -sS -I -K - --max-time 20 \
        https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest 2>/dev/null \
      | tr -d '\r') || headers=""
    limit=$(printf '%s\n' "$headers" | sed -n 's/^ratelimit-limit: *\([0-9]*\).*/\1/p' | head -n 1)
    remaining=$(printf '%s\n' "$headers" | sed -n 's/^ratelimit-remaining: *\([0-9]*\).*/\1/p' | head -n 1)
  fi
  echo "Docker Hub: mirrors $(docker info --format '{{json .RegistryConfig.Mirrors}}' 2>/dev/null || echo unknown);" \
    "account pulls left this hour ${remaining:-unknown} of ${limit:-unknown}."
  return 0
}

attempts=3
err=""
for attempt in $(seq 1 "$attempts"); do
  if err=$(printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin 2>&1 >/dev/null); then
    echo "Docker Hub login succeeded (attempt $attempt of $attempts)."
    summarize || true
    exit 0
  fi
  echo "Docker Hub login attempt $attempt of $attempts failed: $err" >&2
  # A rejection of the credentials is not going to change on a retry.
  if printf '%s' "$err" | grep -Eqi 'unauthorized|incorrect username or password|401'; then
    break
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    sleep $((attempt * 5))
  fi
done

if printf '%s' "$err" | grep -Eqi 'unauthorized|incorrect username or password|401'; then
  echo "::error::Docker Hub rejected the CI credentials (DOCKERHUB_USERNAME / DOCKERHUB_TOKEN)"
  exit 1
fi

first_line=$(printf '%s\n' "$err" | sed -n '/./{p;q;}')
echo "::warning::Docker Hub login unavailable (${first_line:-no error output}); continuing with anonymous pulls"
exit 0
