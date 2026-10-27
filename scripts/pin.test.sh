#!/usr/bin/env bash
# Tests for scripts/pin.sh and the engine-pin.sh wrapper, with no network and no Docker.
#
# Each case copies the scripts into a scratch repository root, so pin.sh writes that root's
# release/images.json and generated CLI file, never this checkout's. The three component
# repositories are local git repositories (PIN_GIT_BASE), and `docker` and `curl` are stubs on PATH
# that answer from fixture files: an image's labels, which tags are published, which CDN files exist.
#
# Usage: bash scripts/pin.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0

# A case fails once, however many of its checks do, and a failed case is never also passed.
fail() {
  printf 'FAIL %s: %s\n' "$CASE" "$*"
  [[ $CASE_FAILED == 1 ]] || failed=$((failed + 1))
  CASE_FAILED=1
}
ok() {
  [[ $CASE_FAILED == 1 ]] && return 0
  printf 'ok   %s\n' "$CASE"
  passed=$((passed + 1))
}

# --- fixtures ---------------------------------------------------------------------------------

# A repository with releases v1.0.0, v1.1.0 (annotated) and v1.2.0-rc.1, one commit each.
make_remote() {
  local dir="$WORK/remotes/$1.git"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
  git -C "$dir" tag v1.0.0
  git -C "$dir" -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
  git -C "$dir" -c user.name=t -c user.email=t@t tag -a -m "1.1.0" v1.1.0
  git -C "$dir" -c user.name=t -c user.email=t@t commit -q --allow-empty -m three
  git -C "$dir" tag v1.2.0-rc.1
}

sha_of() { git -C "$WORK/remotes/$1.git" rev-parse "$2^{commit}"; }

write_stubs() {
  mkdir -p "$WORK/bin" "$WORK/images"
  cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# imagetools inspect <ref> prints $STUB_IMAGES/<ref>.json; pull succeeds for a published ref;
# image inspect answers the revision label or the digest of a pulled ref.
set -euo pipefail
key() { printf '%s' "$1" | tr '/:' '__'; }
if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  file="$STUB_IMAGES/$(key "$4").json"
  [[ -f "$file" ]] || { echo "ERROR: docker.io/$4: not found" >&2; exit 1; }
  cat "$file"
elif [[ "$1" == pull ]]; then
  ref="${*: -1}"
  [[ -f "$STUB_IMAGES/$(key "$ref").json" ]] || { echo "manifest unknown" >&2; exit 1; }
elif [[ "$1 $2" == "image inspect" ]]; then
  if [[ "$*" == *RepoDigests* ]]; then echo "${3%%:*}@sha256:0123abcd"
  else node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.values(j)[0].config.Labels["org.opencontainers.image.revision"]??"")' "$STUB_IMAGES/$(key "$3").json"
  fi
else
  echo "docker stub: unexpected $*" >&2; exit 1
fi
STUB
  cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Succeeds for a URL listed in $STUB_CDN, fails like `curl -f` for any other.
set -euo pipefail
url="${*: -1}"
grep -qxF "$url" "$STUB_CDN" || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
STUB
  chmod +x "$WORK/bin/docker" "$WORK/bin/curl"
}

# Publishes <image>:<tag> to the stub registry, labelled with <revision> unless it is empty.
publish() {
  local image="$1" tag="$2" revision="$3" labels='{}'
  [[ -n "$revision" ]] && labels="{\"org.opencontainers.image.revision\":\"$revision\"}"
  printf '{"linux/amd64":{"config":{"Labels":%s}},"linux/arm64":{"config":{"Labels":%s}}}\n' \
    "$labels" "$labels" >"$STUB_IMAGES/$(printf '%s' "$image:$tag" | tr '/:' '__').json"
}

cdn() { printf 'https://releases.supatype.com/%s/v%s/checksums.sha256\n' "$1" "$2" >>"$STUB_CDN"; }

# A fresh repository root holding the scripts under test and pins at v1.0.0 for all three.
new_root() {
  ROOT="$WORK/root-$CASE_N"
  mkdir -p "$ROOT/scripts/release-train" "$ROOT/release"
  cp "$HERE/pin.sh" "$HERE/engine-pin.sh" "$HERE/release-images.mjs" "$ROOT/scripts/"
  cp "$HERE/release-train/lib.sh" "$ROOT/scripts/release-train/"
  local e s p
  e="$(sha_of schema-engine v1.0.0)" s="$(sha_of server v1.0.0)" p="$(sha_of postgres v1.0.0)"
  printf '{"engine":{"image":"supatype/schema-engine","tag":"v1.0.0","commit":"%s"},"server":{"image":"supatype/server","tag":"v1.0.0","commit":"%s"},"postgres":{"image":"supatype/postgres","tag":"1.0.0","commit":"%s"}}\n' \
    "$e" "$s" "$p" >"$ROOT/release/images.json"
  (cd "$ROOT" && node scripts/release-images.mjs generate)
}

# Every release of every repository published, labelled for the engine only, as on Docker Hub today.
publish_all() {
  local v
  for v in v1.0.0 v1.1.0 v1.2.0-rc.1; do
    publish supatype/schema-engine "$v" "$(sha_of schema-engine "$v")"
    publish supatype/server "$v" ""
    publish supatype/postgres "${v#v}" ""
    cdn engine "${v#v}"; cdn server "${v#v}"; cdn postgres "${v#v}"
  done
}

pin() { (cd "$ROOT" && bash scripts/pin.sh "$@"); }
pinned() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j[process.argv[2]][process.argv[3]])' "$ROOT/release/images.json" "$1" "$2"; }

CASE_N=0
start() {
  CASE="$1" CASE_FAILED=0
  CASE_N=$((CASE_N + 1))
  export STUB_IMAGES="$WORK/images-$CASE_N" STUB_CDN="$WORK/cdn-$CASE_N"
  mkdir -p "$STUB_IMAGES"
  : >"$STUB_CDN"
  new_root
  publish_all
}

# --- setup ------------------------------------------------------------------------------------

for r in schema-engine server postgres; do make_remote "$r"; done
write_stubs
export PATH="$WORK/bin:$PATH" PIN_GIT_BASE="$WORK/remotes" GH_TOKEN=""

# --- cases ------------------------------------------------------------------------------------

start "set server reads the commit from the tag and writes both files"
if out="$(pin set server v1.1.0 2>&1)"; then
  [[ "$(pinned server tag)" == v1.1.0 ]] || fail "tag is $(pinned server tag)"
  [[ "$(pinned server commit)" == "$(sha_of server v1.1.0)" ]] || fail "commit is $(pinned server commit)"
  grep -q "$(sha_of server v1.1.0)" "$ROOT/packages/cli/src/generated/release-images.ts" || fail "generated file not rewritten"
  [[ "$out" == *"no org.opencontainers.image.revision label"* ]] || fail "no warning about the missing label: $out"
  ok
else fail "exit $?: $out"; fi

start "set postgres tags the image without the v and the repository with it"
if out="$(pin set postgres 1.1.0 2>&1)"; then
  [[ "$(pinned postgres tag)" == 1.1.0 ]] || fail "tag is $(pinned postgres tag)"
  [[ "$(pinned postgres commit)" == "$(sha_of postgres v1.1.0)" ]] || fail "commit is $(pinned postgres commit)"
  ok
else fail "exit $?: $out"; fi

start "set engine refuses an image built from another commit"
publish supatype/schema-engine v1.1.0 "$(sha_of schema-engine v1.0.0)"
before="$(cat "$ROOT/release/images.json")"
if out="$(pin set engine v1.1.0 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"built from"* ]]; then fail "wrong reason: $out"
elif [[ "$(cat "$ROOT/release/images.json")" != "$before" ]]; then fail "images.json changed"
else ok; fi

start "set refuses a tag the repository does not have"
if out="$(pin set server v9.9.9 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"has no tag v9.9.9"* ]]; then fail "wrong reason: $out"
else ok; fi

start "set refuses a tag Docker Hub does not have"
rm "$STUB_IMAGES/supatype_server_v1.1.0.json"
if out="$(pin set server v1.1.0 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"supatype/server:v1.1.0 is not published"* ]]; then fail "wrong reason: $out"
else ok; fi

start "check --release-only prints every pinned commit"
if out="$(pin check --release-only 2>/dev/null)"; then
  expected="$(printf 'engine=%s\nserver=%s\npostgres=%s' "$(sha_of schema-engine v1.0.0)" "$(sha_of server v1.0.0)" "$(sha_of postgres v1.0.0)")"
  [[ "$out" == "$expected" ]] && ok || fail "printed: $out"
else fail "exit $?"; fi

start "check refuses a commit the tag does not name"
node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.server.commit="0".repeat(40);require("fs").writeFileSync(f,JSON.stringify(j))' "$ROOT/release/images.json"
if out="$(pin check --release-only 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"server"*"v1.0.0 names"* ]]; then fail "wrong reason: $out"
else ok; fi

start "check --release-only refuses a prerelease"
pin set server v1.2.0-rc.1 >/dev/null 2>&1 || fail "set of a prerelease failed"
if out="$(pin check --release-only 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"v1.2.0-rc.1 is a prerelease"* ]]; then fail "wrong reason: $out"
elif ! pin check >/dev/null 2>&1; then fail "check without --release-only refused it too"
else ok; fi

start "check refuses a pin with no binary on the CDN"
grep -v '/postgres/v1.0.0/' "$STUB_CDN" >"$STUB_CDN.new"; mv "$STUB_CDN.new" "$STUB_CDN"
if out="$(pin check --release-only 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"postgres/v1.0.0/checksums.sha256"* ]]; then fail "wrong reason: $out"
else ok; fi

start "check refuses an image that is no longer published"
rm "$STUB_IMAGES/supatype_postgres_1.0.0.json"
if out="$(pin check 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"supatype/postgres:1.0.0 is not published"* ]]; then fail "wrong reason: $out"
else ok; fi

start "latest names the newest stable release, never a prerelease"
out="$(pin latest server 2>&1)" && [[ "$out" == v1.1.0 ]] && ok || fail "printed: $out"

start "commit and image read the pin"
c="$(pin commit engine)" i="$(pin image postgres)"
[[ "$c" == "$(sha_of schema-engine v1.0.0)" && "$i" == supatype/postgres:1.0.0 ]] && ok || fail "commit $c image $i"

start "engine-image --release-only prints the released engine by digest"
out="$(pin engine-image --release-only 2>/dev/null)" && [[ "$out" == "supatype/schema-engine@sha256:0123abcd" ]] && ok || fail "printed: $out"

start "image refuses a component it does not pin, rather than printing an empty reference"
if out="$(pin image bogus 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"unknown component 'bogus'"* ]]; then fail "wrong reason: $out"
else ok; fi

start "engine-pin.sh image still answers through pin.sh"
out="$(cd "$ROOT" && bash scripts/engine-pin.sh image --release-only 2>/dev/null)" && [[ "$out" == "supatype/schema-engine@sha256:0123abcd" ]] && ok || fail "printed: $out"

start "engine-image --release-only refuses an engine commit no release names"
node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.engine.commit="1".repeat(40);require("fs").writeFileSync(f,JSON.stringify(j))' "$ROOT/release/images.json"
if out="$(pin engine-image --release-only 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"is not a release"* ]]; then fail "wrong reason: $out"
else ok; fi

# A tag listing that fails (an expired GH_TOKEN, an unreachable GitHub) has to stop engine-image
# with that cause. Read inside a test, its failure was discarded and the empty result taken to mean
# "no release names this commit", which reported the wrong problem or started a source build.
start "engine-image --release-only stops on a tag listing that fails"
if out="$(PIN_GIT_BASE="$WORK/unreachable" pin engine-image --release-only 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"cannot list the tags"* ]]; then fail "wrong reason: $out"
elif [[ "$out" == *"is not a release"* ]]; then fail "carried on past the failed listing: $out"
else ok; fi

start "engine-image stops on a tag listing that fails, rather than building from source"
if out="$(PIN_GIT_BASE="$WORK/unreachable" ENGINE_SRC="$WORK/engine-src-$CASE_N" pin engine-image 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"cannot list the tags"* ]]; then fail "wrong reason: $out"
elif [[ "$out" == *"building it from source"* ]]; then fail "started a source build: $out"
else ok; fi

# An unreadable images.json has to be reported as that, not as an image with an empty name.
start "set stops on an unreadable images.json"
printf 'not json\n' >"$ROOT/release/images.json"
if out="$(pin set server v1.1.0 2>&1)"; then fail "accepted: $out"
elif [[ "$out" != *"cannot read"* ]]; then fail "wrong reason: $out"
elif [[ "$out" == *"is not published"* ]]; then fail "carried on with an empty image name: $out"
else ok; fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ $failed == 0 ]]
