#!/usr/bin/env bash
# Check out candidate commits for the release train in CI: one directory per repository, each at
# exactly the commit the resolve job fixed, fetched with no history.
#
# Usage: bash scripts/release-train/checkout.sh <root> <repository> ...
# Environment:
#   OWNER                   GitHub owner of the repositories
#   GH_TOKEN                a token that can read them (supatype-schema-engine is private)
#   SHA_<repository>        the commit, with - in the name written as _ (SHA_supatype_auth)
set -euo pipefail

ROOT="${1:?root directory}"
shift
: "${OWNER:?}" "${GH_TOKEN:?}"
mkdir -p "$ROOT"

for repo in "$@"; do
  var="SHA_${repo//-/_}"
  sha="${!var:-}"
  [[ -n "$sha" ]] || { echo "no commit given for $repo ($var)" >&2; exit 1; }
  dir="$ROOT/$repo"
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" -c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)" \
    fetch -q --depth 1 "https://github.com/$OWNER/$repo.git" "$sha"
  git -C "$dir" checkout -q --detach FETCH_HEAD
  echo "$repo $(git -C "$dir" rev-parse HEAD)"
done
