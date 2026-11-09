#!/usr/bin/env bash
#
# Mint an example's dev keys and export them. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/example-keys.sh"
#
# On a fresh checkout an example's .env holds no keys until something writes them, and a script
# that reads them from there fails with a 401 that names nothing. This mints them with the CLI, from
# the example's own JWT_SECRET, and fails loudly instead.
#
# Call it BEFORE starting the stack, which hands its services the pair in .env. A front end that
# bakes its key in at build time (Next, a native Expo build) also needs the value before its build.
# The Vite examples do not: their builds carry no key, and the page reads it from the server's
# /supatype-env.js, which expect_env_script checks.
#
# The secret lives in the example's .env, which is where `supatype dev` reads it from, so the keys
# minted here verify against the stack that starts later. Set EXAMPLE_JWT_SECRET to choose it;
# otherwise `supatype keys` generates one into .env when it has none, as `supatype dev` would.

source "$(dirname "${BASH_SOURCE[0]}")/env-file.sh"

# mint_keys <example-dir> <cli-bin> - exports ANON_KEY and SERVICE_ROLE_KEY.
mint_keys() {
  local dir="$1" cli="$2" out="" status=0 backup

  touch "$dir/.env"
  # Restored when minting fails, so a failure never leaves a new secret beside the old keys. Kept
  # outside the repo: a copy of .env next to it is a file git would offer to commit.
  backup="$(mktemp)"
  cp "$dir/.env" "$backup"
  # A secret the caller names wins over one a previous run left in .env.
  if [[ -n "${EXAMPLE_JWT_SECRET:-}" ]]; then
    env_file_set "$dir/.env" JWT_SECRET "$EXAMPLE_JWT_SECRET"
  fi

  # `--force` signs every key name .env holds afresh, front-end copies included, so none is left
  # from a previous run that no longer verifies. The pair is read back from .env, the one the stack
  # hands its services: `keys --print` signs a new one.
  out="$(cd "$dir" && node "$cli" keys --force 2>&1)" || status=$?
  ANON_KEY="$(env_file_value "$dir/.env" ANON_KEY)"
  SERVICE_ROLE_KEY="$(env_file_value "$dir/.env" SERVICE_ROLE_KEY)"

  if [[ "$status" -ne 0 || -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" ]]; then
    cp "$backup" "$dir/.env"
    rm -f "$backup"
    echo "ERROR: could not mint keys in $dir. 'supatype keys' said:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  rm -f "$backup"

  export ANON_KEY SERVICE_ROLE_KEY
}

# expect_env_script <page-origin> - fails unless <page-origin>/supatype-env.js answers with a
# script setting window.__SUPATYPE_ENV__ to the stack's anon key ($ANON_KEY, from mint_keys).
# 0.9.1 release test (RB9): the examples' READMEs build with a plain `vite build`, which carries no
# key, so this script is the only way the page gets one.
expect_env_script() {
  local url="${1%/}/supatype-env.js" body
  body="$(curl -sS --connect-timeout 3 --max-time 10 "$url")" || {
    echo "  FAIL $url did not answer" >&2
    return 1
  }
  if [[ "$body" != *"window.__SUPATYPE_ENV__"* || "$body" != *"\"anonKey\":\"$ANON_KEY\""* ]]; then
    echo "  FAIL $url did not set window.__SUPATYPE_ENV__ with the stack's anon key: ${body:0:200}" >&2
    return 1
  fi
  echo "  ok   $url hands the page the stack's anon key"
}
