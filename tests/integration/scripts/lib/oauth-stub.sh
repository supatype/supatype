#!/usr/bin/env bash
#
# A stand-in GitHub for the suites that sign in through OAuth. Source it after http-wait.sh and
# env-file.sh:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/oauth-stub.sh"
#
# The stub (tests/e2e/expo-auth/oauth-stub.mjs) answers the four GitHub Enterprise endpoints the
# auth server calls, and approves every authorize request at once, so a sign-in runs end to end
# against the real auth server with no account anywhere. The auth server runs in a container and
# reaches it through host.docker.internal; a spec that follows the redirect maps that name to this
# machine in its browser.

OAUTH_STUB_CLIENT_ID="${OAUTH_STUB_CLIENT_ID:-expo-e2e-client}"
OAUTH_STUB_SECRET="${OAUTH_STUB_SECRET:-expo-e2e-secret}"

# oauth_stub_start <root-dir> <port> <email> - starts the stub in the background, sets
# OAUTH_STUB_PID for the caller's teardown, and waits until it answers. Returns 1 if it never does.
oauth_stub_start() {
  local root="$1" port="$2" email="$3"
  OAUTH_STUB_PORT="$port" OAUTH_STUB_EMAIL="$email" \
    OAUTH_STUB_CLIENT_ID="$OAUTH_STUB_CLIENT_ID" OAUTH_STUB_SECRET="$OAUTH_STUB_SECRET" \
    node "$root/tests/e2e/expo-auth/oauth-stub.mjs" &
  OAUTH_STUB_PID=$!
  oauth_stub_ready() { http_ok "http://127.0.0.1:${port}/calls"; }
  wait_until 30 "the OAuth stub" oauth_stub_ready
}

# oauth_stub_point_github <env-file> <port> <api-url> - configures the project's GitHub provider,
# in the .env the auth server loads at boot, to use the stub. The server sends the browser to
# <url>/login/oauth/authorize and calls <url>/login/oauth/access_token and <url>/api/v3/user itself.
oauth_stub_point_github() {
  local env_file="$1" port="$2" api_url="$3"
  env_file_set "$env_file" SUPATYPE_EXTERNAL_GITHUB_ENABLED true
  env_file_set "$env_file" SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID "$OAUTH_STUB_CLIENT_ID"
  env_file_set "$env_file" SUPATYPE_EXTERNAL_GITHUB_SECRET "$OAUTH_STUB_SECRET"
  env_file_set "$env_file" SUPATYPE_EXTERNAL_GITHUB_URL "http://host.docker.internal:${port}"
  env_file_set "$env_file" SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI "$api_url/auth/v1/callback"
}
