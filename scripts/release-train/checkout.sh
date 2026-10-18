#!/usr/bin/env bash
# Check out candidate commits for the release train in CI: one directory per repository, each at
# exactly the commit the resolve job fixed, fetched with no history.
#
# Usage: bash scripts/release-train/checkout.sh <root> <repository> ...
# <repository> is a train directory name from lib.sh (TRAIN_REPOS); each is fetched from the GitHub
# repository train_github_repo names for it, so supatype-schema-engine comes from schema-engine.
# Environment:
#   OWNER                   GitHub owner of the repositories
#   GH_TOKEN                a token that can read them. Empty fetches anonymously, which is enough
#                           for a public repository; a private one (cloud) needs PRIVATE_REPO_TOKEN
#   SHA_<repository>        the commit, with - in the name written as _ (SHA_supatype_auth)
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ROOT="${1:?root directory}"
shift
: "${OWNER:?}"
mkdir -p "$ROOT"

auth=()
if [[ -n "${GH_TOKEN:-}" ]]; then
  auth=(-c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)")
fi

for repo in "$@"; do
  var="SHA_${repo//-/_}"
  sha="${!var:-}"
  [[ -n "$sha" ]] || { echo "no commit given for $repo ($var)" >&2; exit 1; }
  github="$(train_github_repo "$repo")"
  dir="$ROOT/$repo"
  rm -rf "$dir"
  git init -q "$dir"
  if ! GIT_TERMINAL_PROMPT=0 git -C "$dir" "${auth[@]}" fetch -q --depth 1 "https://github.com/$OWNER/$github.git" "$sha"; then
    echo "::error::Could not fetch $OWNER/$github at $sha. Either the commit is not on GitHub, or the repository is private and the token given cannot read it (set PRIVATE_REPO_TOKEN)." >&2
    exit 1
  fi
  git -C "$dir" checkout -q --detach FETCH_HEAD
  echo "$repo ($OWNER/$github) $(git -C "$dir" rev-parse HEAD)"
done
