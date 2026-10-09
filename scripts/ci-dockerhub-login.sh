#!/usr/bin/env bash
# Log CI in to Docker Hub so image pulls are not held to the anonymous per-IP rate limit.
#
# Reads DOCKERHUB_USERNAME and DOCKERHUB_TOKEN from the environment; workflows pass them through a
# step `env:` and skip the step when the username is empty (fork and Dependabot PRs get no
# secrets), so those runs pull anonymously.
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

attempts=3
err=""
for attempt in $(seq 1 "$attempts"); do
  if err=$(printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin 2>&1 >/dev/null); then
    echo "Docker Hub login succeeded (attempt $attempt of $attempts)."
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
