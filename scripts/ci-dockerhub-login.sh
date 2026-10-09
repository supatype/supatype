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

# Which credentials the docker CLI will hand the daemon: the config file's credsStore, credHelpers
# and auths keys. Key names only; the values are credentials.
describe_docker_config() {
  local config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  if [ ! -f "$config" ]; then
    echo "  $config: absent"
    return 0
  fi
  python3 - "$config" <<'PY' || echo "  $config: unreadable"
import json, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
print("  %s: credsStore=%s credHelpers=%s auths=%s" % (
    path,
    cfg.get("credsStore") or "-",
    ",".join(sorted(cfg.get("credHelpers") or {})) or "-",
    ",".join(sorted(cfg.get("auths") or {})) or "-",
))
PY
}

# Proves whether pulls on this runner will count as authenticated, without spending a pull: a HEAD
# of Docker Hub's rate-limit preview manifest is free and answers with the limit that applies and
# who it is charged to (`docker-ratelimit-source` is the account for an authenticated token and the
# runner's IP for an anonymous one). Asked once with the CI credentials and once without, next to
# the daemon's mirrors and the CLI's config. Prints no credential or token, and never fails the step.
ratelimit_headers() {
  # $1: a curl config line naming the Authorization header (keeps the token off the command line).
  printf '%s' "$1" | curl -sS -I -K - --max-time 20 \
    https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest 2>&1 \
    | tr -d '\r' | grep -Ei '^(HTTP/|ratelimit-limit|ratelimit-remaining|docker-ratelimit-source|curl:)' \
    | sed 's/^/    /'
}

diagnose() {
  echo "Docker Hub diagnostics:"
  echo "  DOCKER_CONFIG=${DOCKER_CONFIG:-unset} HOME=$HOME"
  describe_docker_config
  echo "  daemon registry mirrors: $(docker info --format '{{json .RegistryConfig.Mirrors}}' 2>&1 | head -n 1)"
  echo "  daemon image store: $(docker info --format '{{.Driver}} {{json .DriverStatus}}' 2>&1 | head -n 1)"

  local scope="repository:ratelimitpreview/test:pull" body status token
  body=$(printf 'user = "%s:%s"\n' "$DOCKERHUB_USERNAME" "$DOCKERHUB_TOKEN" \
    | curl -sS -K - --max-time 20 -w '\n%{http_code}' \
      "https://auth.docker.io/token?service=registry.docker.io&scope=$scope" 2>/dev/null) || body=""
  status=$(printf '%s\n' "$body" | tail -n 1)
  token=$(printf '%s\n' "$body" | sed '$d' \
    | python3 -c 'import json, sys; print(json.load(sys.stdin).get("token", ""))' 2>/dev/null) || token=""
  echo "  token request with the CI credentials: HTTP ${status:-none}"
  if [ -n "$token" ]; then
    echo "  rate limit with the CI credentials:"
    ratelimit_headers "header = \"Authorization: Bearer $token\""
  fi

  body=$(curl -sS --max-time 20 \
    "https://auth.docker.io/token?service=registry.docker.io&scope=$scope" 2>/dev/null) || body=""
  token=$(printf '%s\n' "$body" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin).get("token", ""))' 2>/dev/null) || token=""
  if [ -n "$token" ]; then
    echo "  rate limit anonymously (this runner's IP):"
    ratelimit_headers "header = \"Authorization: Bearer $token\""
  fi
  return 0
}

echo "Docker CLI config before login:"
describe_docker_config

attempts=3
err=""
for attempt in $(seq 1 "$attempts"); do
  if err=$(printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin 2>&1 >/dev/null); then
    echo "Docker Hub login succeeded (attempt $attempt of $attempts)."
    diagnose || true
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
