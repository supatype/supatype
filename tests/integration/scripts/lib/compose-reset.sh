#!/usr/bin/env bash
#
# Remove everything a compose project left behind: its containers, networks and volumes. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/compose-reset.sh"
#   remove_compose_project supatype-conformance
#
# A script calls it before it scaffolds, not only in its teardown. Each run generates a fresh
# POSTGRES_PASSWORD and Postgres only applies one on first init, so a database volume that outlived
# the last run rejects the new credentials with "password authentication failed" and `dev` retries
# until it times out. A harness that depends on its own teardown having succeeded is not one you
# can trust.
#
# Matched on the compose project label, which is exact. A `name=` filter is a substring match and
# also takes any other project whose name starts with this one.

remove_compose_project() {
  local label="label=com.docker.compose.project=$1"
  local ids
  ids="$(docker ps -aq --filter "$label" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
  ids="$(docker network ls -q --filter "$label" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then docker network rm $ids >/dev/null 2>&1 || true; fi
  ids="$(docker volume ls -q --filter "$label" 2>/dev/null || true)"
  if [[ -n "$ids" ]]; then docker volume rm -f $ids >/dev/null 2>&1 || true; fi
}
