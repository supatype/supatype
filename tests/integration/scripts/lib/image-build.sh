#!/usr/bin/env bash
#
# Building a service image from this checkout for the live-stack scripts. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/image-build.sh"
#
# A suite that asserts behaviour only the working tree has must not run against the published tag:
# that tests the last release and reports it as this change passing.

# build_unless_given <given> <tag> <docker build args...> - builds <tag> from the checkout, unless
# the caller named an image in <given> and already has <tag>. The release train hands over the
# images it built from the candidate commits; rebuilding under the same tag here replaced them, so
# a suite tested a build of its own while the train reported the train's.
build_unless_given() {
  local given="$1" tag="$2"
  shift 2
  if [[ -n "$given" ]] && docker image inspect "$tag" >/dev/null 2>&1; then
    echo "  using $tag as given"
    return 0
  fi
  docker build -q -t "$tag" "$@" >/dev/null
}
