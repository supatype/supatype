#!/usr/bin/env bash
#
# Mint an example's dev keys and export them. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/example-keys.sh"
#
# `supatype dev` does not write ANON_KEY into .env — only `init` and `self-host` do. A script that
# reads the keys from there therefore works on a machine where `init` once ran and fails on a fresh
# checkout, where it never did, with a 401 that names nothing. This mints them the same way the CLI
# does, from the example's own JWT_SECRET, and fails loudly instead.
#
# Call it BEFORE starting the stack: a front end that bakes its key in at build time (Vite,
# Next) needs the value to exist before its build runs, not after.

# The secret `supatype dev` falls back to when .env names none. Written explicitly so the keys this
# mints verify against the stack that starts later, rather than depending on which of the two paths
# happened to run first.
EXAMPLE_JWT_SECRET="${EXAMPLE_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"

# mint_keys <example-dir> <cli-bin> - exports ANON_KEY and SERVICE_ROLE_KEY.
mint_keys() {
  local dir="$1" cli="$2" out=""

  if [[ ! -f "$dir/.env" ]] || ! grep -q '^JWT_SECRET=' "$dir/.env"; then
    printf 'JWT_SECRET=%s\n' "$EXAMPLE_JWT_SECRET" >> "$dir/.env"
  fi

  out="$(cd "$dir" && node "$cli" keys 2>&1)" || true
  ANON_KEY="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*ANON_KEY=//p' | tail -1)"
  SERVICE_ROLE_KEY="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*SERVICE_ROLE_KEY=//p' | tail -1)"

  if [[ -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" ]]; then
    echo "ERROR: could not mint keys in $dir. 'supatype keys' said:" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi

  export ANON_KEY SERVICE_ROLE_KEY
}
