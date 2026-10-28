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
# Call it BEFORE starting the stack: a front end that bakes its key in at build time (Vite,
# Next) needs the value to exist before its build runs, not after.
#
# The secret lives in the example's .env, which is where `supatype dev` reads it from, so the keys
# minted here verify against the stack that starts later. Set EXAMPLE_JWT_SECRET to choose it;
# otherwise `supatype keys` generates one into .env when it has none, as `supatype dev` would.

source "$(dirname "${BASH_SOURCE[0]}")/env-file.sh"

# mint_keys <example-dir> <cli-bin> - exports ANON_KEY and SERVICE_ROLE_KEY.
mint_keys() {
  local dir="$1" cli="$2" out=""

  touch "$dir/.env"
  if [[ -n "${EXAMPLE_JWT_SECRET:-}" ]] && ! grep -q '^JWT_SECRET=.' "$dir/.env"; then
    printf 'JWT_SECRET=%s\n' "$EXAMPLE_JWT_SECRET" >> "$dir/.env"
  fi

  # Read the pair back from .env, the one the stack hands its services: `keys --print` signs a new one.
  out="$(cd "$dir" && node "$cli" keys 2>&1)" || true
  ANON_KEY="$(env_file_value "$dir/.env" ANON_KEY)"
  SERVICE_ROLE_KEY="$(env_file_value "$dir/.env" SERVICE_ROLE_KEY)"

  if [[ -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" ]]; then
    echo "ERROR: could not mint keys in $dir. 'supatype keys' said:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi

  export ANON_KEY SERVICE_ROLE_KEY
}
