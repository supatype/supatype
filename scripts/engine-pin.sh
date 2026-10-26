#!/usr/bin/env bash
# The engine this repository is built and released against: the commit in
# .github/schema-engine-commit, never whatever supatype/schema-engine:latest is that day.
#
# Usage:
#   bash scripts/engine-pin.sh set <engine tag>          point the pin at the commit the engine's
#                                                        release tag names (vX.Y.Z)
#   bash scripts/engine-pin.sh image [--release-only]    print the engine image for the pin
#
# `set` is the release step (Self-Host-Launch-Remaining.md, release order step 5): it reads the
# commit from the tag rather than from someone's clipboard, and refuses a tag whose Docker Hub image
# was built from a different commit, so the pin, the tag and the image cannot disagree.
#
# `image` resolves the pin for a control-plane build:
#   - a commit an engine release tag names resolves to that release's Docker Hub image, checked by
#     its org.opencontainers.image.revision label and printed by digest, so the build copies the
#     engine from exactly the image that was checked;
#   - a commit with no release tag (a stack ahead of the engine release) is built from source with
#     the release train's checkout and build, and printed as the train's engine image. With
#     --release-only (release.yml) it is an error instead: a release ships a released engine.
# Build output goes to stderr; stdout carries only the image reference.
#
# Environment:
#   OWNER              GitHub owner (default supatype)
#   GH_TOKEN           read access to the engine repository while it is private. Without one the
#                      tags are listed anonymously, which works once the repository is public
#   ENGINE_SRC         where the source build checks the engine out (default: a new temp directory)
#   ENGINE_IMAGE_REPO  the image repository releases are read from (default supatype/schema-engine),
#                      for testing this script against a local registry
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/release-train/lib.sh"

OWNER="${OWNER:-supatype}"
PIN_FILE="$ROOT/.github/schema-engine-commit"
ENGINE_REPO="$(train_github_repo supatype-schema-engine)"
IMAGE_REPO="${ENGINE_IMAGE_REPO:-supatype/schema-engine}"

die() { printf 'engine-pin: %s\n' "$*" >&2; exit 1; }

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

pinned_sha() {
  local sha
  sha="$(tr -d '[:space:]' <"$PIN_FILE")"
  is_sha "$sha" || die "$PIN_FILE must hold a full 40-character commit, got '$sha'"
  printf '%s\n' "$sha"
}

# `<commit> <tag>` for every release tag in the engine repository. An annotated tag is listed twice,
# once as the tag object and once peeled (`^{}`) to its commit; only the commit is wanted, so the
# peeled line replaces the other.
release_tags() {
  local auth=() listing
  if [[ -n "${GH_TOKEN:-}" ]]; then
    auth=(-c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)")
  fi
  listing="$(GIT_TERMINAL_PROMPT=0 git "${auth[@]}" ls-remote --tags "https://github.com/$OWNER/$ENGINE_REPO.git" 'v*')" \
    || die "cannot list the tags of $OWNER/$ENGINE_REPO (set GH_TOKEN while it is private)"
  awk '{ t = $2; sub("^refs/tags/", "", t); peeled = sub("\\^\\{\\}$", "", t); if (peeled || !(t in c)) c[t] = $1 }
       END { for (t in c) print c[t], t }' <<<"$listing" \
    | grep -E ' v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || true
}

# The release tag at a commit, a stable one (no '-') over a prerelease. Empty when there is none.
tag_at() {
  local sha="$1"
  release_tags | awk -v sha="$sha" '$1 == sha { print $2 }' | sort -V | awk '!/-/ { s = $0 } /-/ { p = $0 } END { print (s != "" ? s : p) }'
}

# The commit a release tag names. Empty when the tag does not exist.
commit_of() {
  local tag="$1"
  release_tags | awk -v tag="$tag" '$2 == tag { print $1 }'
}

# Pulls the release image and prints it by digest, after checking it was built from <sha>.
released_image() {
  local tag="$1" sha="$2" ref revision digest
  ref="$IMAGE_REPO:$tag"
  docker pull -q --platform linux/amd64 "$ref" >/dev/null || die "cannot pull $ref"
  revision="$(docker image inspect "$ref" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  [[ "$revision" == "$sha" ]] || die "$ref was built from '$revision', not $sha"
  digest="$(docker image inspect "$ref" --format '{{ range .RepoDigests }}{{ println . }}{{ end }}' | grep -m1 "^$IMAGE_REPO@sha256:")" \
    || die "$ref has no registry digest"
  printf '%s\n' "$digest"
}

# Builds the engine image at <sha> the way the release train does, and prints its reference.
source_image() {
  local sha="$1" src="${ENGINE_SRC:-}"
  [[ -n "$src" ]] || src="$(mktemp -d)"
  SHA_supatype_schema_engine="$sha" OWNER="$OWNER" GH_TOKEN="${GH_TOKEN:-}" \
    bash "$ROOT/scripts/release-train/checkout.sh" "$src" supatype-schema-engine >&2
  bash "$ROOT/scripts/release-train/build.sh" --src "$src" engine >&2
  train_image engine
}

cmd_image() {
  local release_only=0 sha tag
  [[ "${1:-}" == "--release-only" ]] && release_only=1
  sha="$(pinned_sha)"
  tag="$(tag_at "$sha")"
  if [[ -n "$tag" ]]; then
    printf 'engine-pin: %s is %s\n' "${sha:0:12}" "$tag" >&2
    released_image "$tag" "$sha"
  elif [[ "$release_only" == 1 ]]; then
    die "the pinned engine commit ${sha:0:12} is not a release: no tag in $OWNER/$ENGINE_REPO names it. Release the engine first, then run 'bash scripts/engine-pin.sh set v<version>' and commit the result"
  else
    printf 'engine-pin: %s has no release tag, building it from source\n' "${sha:0:12}" >&2
    source_image "$sha"
  fi
}

cmd_set() {
  local tag="${1:?usage: engine-pin.sh set <engine tag, e.g. v0.7.0>}" sha
  [[ "$tag" == v* ]] || tag="v$tag"
  sha="$(commit_of "$tag")"
  [[ -n "$sha" ]] || die "$OWNER/$ENGINE_REPO has no tag $tag"
  released_image "$tag" "$sha" >/dev/null
  printf '%s\n' "$sha" >"$PIN_FILE"
  printf 'engine-pin: %s now names %s (%s)\n' "${PIN_FILE#"$ROOT/"}" "$sha" "$tag" >&2
  printf 'engine-pin: regenerate the examples with it and commit them too: pnpm generate:examples\n' >&2
}

case "${1:-}" in
  image) shift; cmd_image "$@" ;;
  set) shift; cmd_set "$@" ;;
  *) sed -n '2,29p' "$0" >&2; exit 2 ;;
esac
