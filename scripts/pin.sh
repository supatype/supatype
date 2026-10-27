#!/usr/bin/env bash
# The images a release runs that are built in other repositories: the schema engine, the server and
# Postgres. release/images.json pins each to a Docker Hub tag and the commit that tag names, never
# whatever :latest is that day. The CLI renders exactly these (packages/cli/src/generated/
# release-images.ts, written from the same file), and the release train tests exactly these.
#
# Usage:
#   bash scripts/pin.sh set <engine|server|postgres> <tag>   point a pin at a release tag
#   bash scripts/pin.sh check [--release-only]               verify every pin, print component=commit
#   bash scripts/pin.sh latest <component>                   the newest stable release tag
#   bash scripts/pin.sh commit|tag|image <component>         read a pin
#   bash scripts/pin.sh engine-image [--release-only]        the engine image a control plane copies
#
# `set` reads the commit from the tag in the component's repository rather than from someone's
# clipboard, refuses a tag whose Docker Hub image is missing or was built from a different commit,
# and refuses one whose binary the CLI downloads natively is missing from the CDN. Tags: the engine
# and the server tag images `vX.Y.Z` like their repositories; Postgres tags images `X.Y.Z` and its
# repository `vX.Y.Z`. Either spelling is accepted.
#
# The commit check reads the image's org.opencontainers.image.revision label. The engine's images
# carry it. The server's and Postgres's do not (their release workflows set no labels), so for those
# only that the tag is published can be checked, and the script says so.
#
# `check` is the release gate (release.yml): every pin's tag names its commit, its image and CDN
# binary are published, and the CLI's generated copy matches. --release-only also refuses a
# prerelease tag. Stdout carries only `engine=<sha>`, `server=<sha>` and `postgres=<sha>`.
#
# `engine-image` resolves the engine pin for a control-plane build:
#   - a commit an engine release tag names resolves to that release's Docker Hub image, checked by
#     its revision label and printed by digest, so the build copies the engine from exactly the
#     image that was checked;
#   - a commit with no release tag (a stack ahead of the engine release) is built from source with
#     the release train's checkout and build, and printed as the train's engine image. With
#     --release-only it is an error instead: a release ships a released engine.
# Build output goes to stderr; stdout carries only the image reference.
#
# Environment:
#   OWNER              GitHub owner (default supatype)
#   GH_TOKEN           read access to a component repository while it is private. Without one the
#                      tags are listed anonymously, which works for a public repository
#   ENGINE_SRC         where the source build checks the engine out (default: a new temp directory)
#   ENGINE_IMAGE_REPO  the engine image repository (default: the pin's), for testing against a
#                      local registry
#   PIN_GIT_BASE       where the component repositories are read (default https://github.com/$OWNER)
#   PIN_CDN_BASE       where the CLI downloads binaries (default https://releases.supatype.com)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/release-train/lib.sh"

OWNER="${OWNER:-supatype}"
GIT_BASE="${PIN_GIT_BASE:-https://github.com/$OWNER}"
CDN_BASE="${PIN_CDN_BASE:-https://releases.supatype.com}"
COMPONENTS=(engine server postgres)

die() { printf 'pin: %s\n' "$*" >&2; exit 1; }
note() { printf 'pin: %s\n' "$*" >&2; }

pins() { node "$ROOT/scripts/release-images.mjs" "$@"; }

# The GitHub repository a component is released from, by way of the train's directory for it, so a
# repository rename is made once, in train_github_repo.
repo_of() {
  case "$1" in
    engine) train_github_repo supatype-schema-engine ;;
    server) train_github_repo supatype-auth ;;
    postgres) train_github_repo supatype-postgres ;;
    *) die "unknown component '$1', expected engine, server or postgres" ;;
  esac
}

# A component's image at <tag>. The read returns on failure explicitly: bash clears set -e inside a
# command substitution, and every caller reads this through one.
image_ref() {
  local image
  image="$(pins get "$1" image)" || return
  printf '%s:%s\n' "$image" "$2"
}

# A version's spellings: the repository tags vX.Y.Z; Postgres tags its images without the v.
git_tag() { printf 'v%s\n' "${1#v}"; }
image_tag() { if [[ "$1" == postgres ]]; then printf '%s\n' "${2#v}"; else git_tag "$2"; fi; }

# `<commit> <tag>` for every release tag in a component's repository. An annotated tag is listed
# twice, once as the tag object and once peeled (`^{}`) to its commit; only the commit is wanted,
# so the peeled line replaces the other.
release_tags() {
  local repo="$1" auth=() basic listing
  if [[ -n "${GH_TOKEN:-}" ]]; then
    basic="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')" || die "cannot encode GH_TOKEN"
    auth=(-c "http.extraheader=Authorization: Basic $basic")
  fi
  listing="$(GIT_TERMINAL_PROMPT=0 git "${auth[@]}" ls-remote --tags "$GIT_BASE/$repo.git" 'v*')" \
    || die "cannot list the tags of $OWNER/$repo (set GH_TOKEN while it is private)"
  awk '{ t = $2; sub("^refs/tags/", "", t); peeled = sub("\\^\\{\\}$", "", t); if (peeled || !(t in c)) c[t] = $1 }
       END { for (t in c) print c[t], t }' <<<"$listing" \
    | grep -E ' v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || true
}

# The commit a release tag names. Empty when the tag does not exist.
commit_of() { release_tags "$1" | awk -v tag="$2" '$2 == tag { print $1 }'; }

# Every org.opencontainers.image.revision label across an image's platforms, one per line; none when
# the image carries no label. Read from the registry, so nothing is pulled.
image_revisions() {
  local ref="$1" json
  json="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}' 2>/dev/null)" \
    || die "$ref is not published on Docker Hub (or Docker Hub could not be reached)"
  printf '%s' "$json" | node -e '
    const image = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
    const platforms = image.config ? [image] : Object.values(image)
    const revisions = platforms.map((p) => p?.config?.Labels?.["org.opencontainers.image.revision"]).filter(Boolean)
    for (const r of new Set(revisions)) console.log(r)'
}

# Refuses an image that is missing or was built from another commit than <sha>.
verify_image() {
  local ref="$1" sha="$2" revisions revision
  revisions="$(image_revisions "$ref")"
  if [[ -z "$revisions" ]]; then
    note "$ref has no org.opencontainers.image.revision label, so only that it is published was checked, not which commit it was built from"
    return 0
  fi
  while IFS= read -r revision; do
    [[ "$revision" == "$sha" ]] || die "$ref was built from '$revision', not $sha"
  done <<<"$revisions"
}

# Refuses a version whose binary `supatype dev` would download natively and cannot.
verify_cdn() {
  local url="$CDN_BASE/$1/v${2#v}/checksums.sha256"
  curl -fsSI "$url" >/dev/null 2>&1 || die "$url is not published, and the CLI downloads $1 ${2#v} from it"
}

cmd_set() {
  local component="${1:?usage: pin.sh set <engine|server|postgres> <tag>}" tag="${2:?usage: pin.sh set <component> <tag>}"
  local repo sha ref
  repo="$(repo_of "$component")"
  sha="$(commit_of "$repo" "$(git_tag "$tag")")"
  [[ -n "$sha" ]] || die "$OWNER/$repo has no tag $(git_tag "$tag")"
  ref="$(image_ref "$component" "$(image_tag "$component" "$tag")")"
  verify_image "$ref" "$sha"
  verify_cdn "$component" "$tag"
  pins set "$component" "$(image_tag "$component" "$tag")" "$sha"
  note "release/images.json now pins $component to $ref ($sha)"
  if [[ "$component" == engine ]]; then
    note "regenerate the examples with it and commit them too: pnpm generate:examples"
  fi
}

# Verifies one pin and prints `<component>=<commit>`.
check_one() {
  local component="$1" release_only="$2" repo tag sha named ref
  repo="$(repo_of "$component")"
  tag="$(pins get "$component" tag)"
  sha="$(pins get "$component" commit)"
  if [[ "$release_only" == 1 && "$tag" == *-* ]]; then
    die "$component: $tag is a prerelease, and a release ships released components. Run 'bash scripts/pin.sh set $component <stable tag>'"
  fi
  named="$(commit_of "$repo" "$(git_tag "$tag")")"
  [[ -n "$named" ]] || die "$component: $OWNER/$repo has no tag $(git_tag "$tag")"
  [[ "$named" == "$sha" ]] || die "$component: $(git_tag "$tag") names $named, not the pinned $sha"
  ref="$(image_ref "$component" "$tag")"
  verify_image "$ref" "$sha"
  verify_cdn "$component" "$tag"
  printf '%s=%s\n' "$component" "$sha"
}

cmd_check() {
  local release_only=0 component
  [[ "${1:-}" == "--release-only" ]] && release_only=1
  for component in "${COMPONENTS[@]}"; do check_one "$component" "$release_only"; done
  pins generate --check
}

cmd_latest() {
  local repo
  repo="$(repo_of "${1:?usage: pin.sh latest <component>}")"
  release_tags "$repo" | awk '{ print $2 }' | grep -v -- - | sort -V | tail -n 1
}

# --- engine-image: the control plane's engine ---------------------------------------------------

# Pulls the release image and prints it by digest, after checking it was built from <sha>.
released_image() {
  local repo="$1" tag="$2" sha="$3" ref revision digest
  ref="$repo:$tag"
  docker pull -q --platform linux/amd64 "$ref" >/dev/null || die "cannot pull $ref"
  revision="$(docker image inspect "$ref" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  [[ "$revision" == "$sha" ]] || die "$ref was built from '$revision', not $sha"
  digest="$(docker image inspect "$ref" --format '{{ range .RepoDigests }}{{ println . }}{{ end }}' | grep -m1 "^$repo@sha256:")" \
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

cmd_engine_image() {
  local release_only=0 sha tag repo engine_repo named
  [[ "${1:-}" == "--release-only" ]] && release_only=1
  sha="$(pins get engine commit)"
  tag="$(pins get engine tag)"
  repo="${ENGINE_IMAGE_REPO:-$(pins get engine image)}"
  engine_repo="$(repo_of engine)"
  # Assigned on its own line: inside the test below, a failed tag listing would read as "no release
  # names this commit" and carry on to the wrong error or a source build.
  named="$(commit_of "$engine_repo" "$(git_tag "$tag")")"
  if [[ "$named" == "$sha" ]]; then
    note "engine ${sha:0:12} is $tag"
    released_image "$repo" "$tag" "$sha"
  elif [[ "$release_only" == 1 ]]; then
    die "the pinned engine commit ${sha:0:12} is not a release: $(git_tag "$tag") in $OWNER/$engine_repo does not name it. Release the engine first, then run 'bash scripts/pin.sh set engine v<version>' and commit the result"
  else
    note "engine ${sha:0:12} has no release tag, building it from source"
    source_image "$sha"
  fi
}

read_pin() {
  local field="$1" component="${2:?usage: pin.sh $1 <component>}" tag
  if [[ "$field" == image ]]; then
    # Assigned first: a failed read inside an argument would not stop the script.
    tag="$(pins get "$component" tag)"
    image_ref "$component" "$tag"
  else
    pins get "$component" "$field"
  fi
}

case "${1:-}" in
  set) shift; cmd_set "$@" ;;
  check) shift; cmd_check "$@" ;;
  latest) shift; cmd_latest "$@" ;;
  commit | tag | image) read_pin "$@" ;;
  engine-image) shift; cmd_engine_image "$@" ;;
  *) sed -n '2,44p' "$0" >&2; exit 2 ;;
esac
