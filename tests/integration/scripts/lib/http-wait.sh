#!/usr/bin/env bash
#
# Bounded polling for the integration scripts. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/http-wait.sh"
#
# Two rules it exists to enforce, both learned from a soak that hung for 44 minutes and then
# told us nothing:
#
#   1. Every request is bounded. An unbounded curl blocks forever when something accepts the
#      connection and never answers, which is exactly what a half-up stack does. One such call
#      freezes the poll loop, so the loop's own timeout never expires.
#   2. The timeout is wall clock. `for i in $(seq 1 300)` with a one second sleep is not five
#      minutes, it is five minutes plus however long 300 requests took, and it reports the
#      iteration count as if it were seconds.
#      A deadline can be overshot by at most one bounded request, so 5s of slack, not 40 minutes.

# http_ok <curl-args...> - true when the request answers success within the bound. Arguments go
# to curl untouched, so a caller needing headers writes them out. No array pattern substitution:
# it behaves differently on the bash 3.2 that ships with macOS.
http_ok() {
  curl -sf --connect-timeout 3 --max-time 5 "$@" >/dev/null 2>&1
}

# http_status <curl-args...> - prints the status code, or 000 when nothing answered. curl writes
# 000 itself on a timeout and then exits non-zero, so the fallback must not print a second code.
http_status() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 5 "$@" 2>/dev/null)"
  printf '%s' "${code:-000}"
}

# wait_until <seconds> <label> <predicate> - polls the predicate once a second until it
# succeeds. Returns 0 with the real elapsed time reported, or 1 once the deadline passes.
# <predicate> is the name of a shell function; it decides what "ready" means, so a caller
# needing several endpoints or a file on disk does not need a variant of this loop.
wait_until() {
  local limit="$1" label="$2" predicate="$3"
  echo "==> Waiting for ${label} (up to ${limit}s)..."
  local started=$SECONDS next=30 elapsed
  while :; do
    elapsed=$(( SECONDS - started ))
    (( elapsed >= limit )) && break
    if "$predicate"; then
      echo "  ${label} ready after $(( SECONDS - started ))s"
      return 0
    fi
    if (( elapsed >= next )); then
      echo "  Still waiting (${elapsed}s)..."
      next=$(( next + 30 ))
    fi
    sleep 1
  done
  echo "ERROR: ${label} did not become ready within ${limit}s" >&2
  return 1
}
