#!/usr/bin/env bash
#
# Which compose project a live-stack script runs, and a claim on the directory it runs in. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/e2e-project.sh"
#
# Every script used to run its stack under the project name in the example's config, and tear down
# `supatype-<that name>`. Two runs on one machine, from two checkouts, then shared one compose
# project: the second `supatype dev` took the first run's gateway port as its own (it is held by
# "this" project) and recreated its containers, and whichever run finished first ran `down -v` on
# the other's stack.
#
# SUPATYPE_E2E_PROJECT names the project for one run. Unset, every script runs exactly as before.
# The name reaches `supatype dev` through supatype.local.config.ts, which the CLI merges over the
# project's config; an existing local config is kept and merged into, and restored afterwards.
#
# Ports are overridable already, and every script passes its own on to the CLI:
#   SUPATYPE_KONG_PORT        the gateway (default 18473)
#   SUPATYPE_DEV_DB_PORT      the database on the host (default: the first free port from 54329)
#   SUPATYPE_STUDIO_DEV_PORT  the Studio dev server, when a project runs Studio from source (3002)
# plus the per-script ones each script lists at its top.
#
# Usage, before the script writes anything into the project directory or sets its cleanup trap:
#
#   e2e_project_use "$EXAMPLE_DIR" framework-parity     # sets E2E_COMPOSE_PROJECT
#   cleanup() { ...; e2e_project_down; e2e_project_release; }

E2E_LOCAL_CONFIG_CANDIDATES=(supatype.local.config.ts supatype.local.config.js supatype.local.config.mjs)
E2E_PROJECT_DIR=""
E2E_PREVIOUS_CONFIG=""
E2E_WROTE_CONFIG="no"
E2E_LOCK_DIR=""

# e2e_project_use <project-dir> <config-name> - sets E2E_PROJECT_NAME and E2E_COMPOSE_PROJECT (what
# the CLI names the compose project), takes the directory's lock, refuses a project another
# directory is running, and points the project at SUPATYPE_E2E_PROJECT when that is set.
e2e_project_use() {
  local dir="$1" default_name="$2"
  E2E_PROJECT_DIR="$dir"
  E2E_PROJECT_NAME="${SUPATYPE_E2E_PROJECT:-$default_name}"
  if [[ ! "$E2E_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "ERROR: SUPATYPE_E2E_PROJECT='$E2E_PROJECT_NAME' must be lower case letters, digits, - and _" >&2
    return 1
  fi
  E2E_COMPOSE_PROJECT="supatype-${E2E_PROJECT_NAME}"
  export E2E_PROJECT_NAME E2E_COMPOSE_PROJECT
  e2e_lock "$dir" || return 1
  if ! e2e_refuse_foreign_project; then
    e2e_project_release
    return 1
  fi
  if [[ "$E2E_PROJECT_NAME" != "$default_name" ]]; then
    e2e_write_name_override "$dir" "$E2E_PROJECT_NAME"
  fi
}

# e2e_scoped <name> - a container name of this run: <name> by default, <name>-<project> under an
# override, so two runs never claim one name.
e2e_scoped() {
  if [[ -n "${SUPATYPE_E2E_PROJECT:-}" ]]; then printf '%s-%s' "$1" "$SUPATYPE_E2E_PROJECT"; else printf '%s' "$1"; fi
}

# One run per directory: two runs in one checkout share its .env, generated compose file and build
# output, and no project name separates those. A second run is refused rather than left to corrupt
# the first. Runs side by side need checkouts of their own. A script that writes into the directory
# before choosing its project calls this first; e2e_project_use then keeps the lock it holds.
e2e_lock() {
  [[ -z "$E2E_LOCK_DIR" ]] || return 0
  local lock="$1/.supatype/.e2e-run.lock.d"
  mkdir -p "$1/.supatype"
  if ! mkdir "$lock" 2>/dev/null; then
    echo "ERROR: another live-stack run is using $1." >&2
    echo "  Run the second one from another checkout, or remove $lock if no run is left." >&2
    return 1
  fi
  E2E_LOCK_DIR="$lock"
}

# A path as Docker records it in a compose label, lower-cased with forward slashes, so a Git Bash
# path and a Windows one compare equal.
e2e_label_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -m "$p")"; fi
  printf '%s' "$p" | tr '\\' '/' | tr '[:upper:]' '[:lower:]'
}

# Fails when the compose project already has containers started from another directory: that is
# another run's stack, and starting this one would take it over and tear it down. Leftovers from
# this directory's own earlier run are not a conflict; the scripts replace those as before.
e2e_refuse_foreign_project() {
  local here files file
  here="$(e2e_label_path "$E2E_PROJECT_DIR")"
  files="$(docker ps -a --filter "label=com.docker.compose.project=$E2E_COMPOSE_PROJECT" \
    --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | sort -u)" || return 0
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    file="$(e2e_label_path "$file")"
    if [[ "$file" != "$here/"* ]]; then
      echo "ERROR: compose project $E2E_COMPOSE_PROJECT is running from another directory ($file)." >&2
      echo "  Set SUPATYPE_E2E_PROJECT to a name of this run's own." >&2
      return 1
    fi
  done <<<"$files"
}

e2e_write_name_override() {
  local dir="$1" name="$2" candidate import_from=""
  for candidate in "${E2E_LOCAL_CONFIG_CANDIDATES[@]}"; do
    [[ -f "$dir/$candidate" ]] || continue
    if [[ "$candidate" == "supatype.local.config.ts" ]]; then
      # The file this writes has the same name, so the one already there moves aside first.
      E2E_PREVIOUS_CONFIG="$dir/supatype.local.config.e2e-previous.ts"
      mv "$dir/$candidate" "$E2E_PREVIOUS_CONFIG"
      import_from="./supatype.local.config.e2e-previous.ts"
    else
      import_from="./$candidate"
    fi
    break
  done
  E2E_WROTE_CONFIG="yes"
  if [[ -z "$import_from" ]]; then
    printf 'export default { project: { name: "%s" } }\n' "$name" >"$dir/supatype.local.config.ts"
    return 0
  fi
  cat >"$dir/supatype.local.config.ts" <<TS
import previous from "${import_from}"
export default { ...previous, project: { ...(previous.project ?? {}), name: "${name}" } }
TS
}

# e2e_project_claimed - true while this run holds the directory, so its teardown may stop the stack.
e2e_project_claimed() {
  [[ -n "$E2E_LOCK_DIR" ]]
}

# e2e_project_down [down-args...] - `docker compose down` for this run's project, and only when this
# run claimed it. Extra arguments replace the default `-v --remove-orphans`.
e2e_project_down() {
  e2e_project_claimed || return 0
  local args=("$@")
  [[ ${#args[@]} -gt 0 ]] || args=(-v --remove-orphans)
  (cd "$E2E_PROJECT_DIR" && docker compose -p "$E2E_COMPOSE_PROJECT" down "${args[@]}") >/dev/null 2>&1 || true
}

# e2e_project_release - undoes e2e_project_use. Safe to call when it never ran.
e2e_project_release() {
  if [[ "$E2E_WROTE_CONFIG" == "yes" ]]; then
    rm -f "$E2E_PROJECT_DIR/supatype.local.config.ts"
    if [[ -n "$E2E_PREVIOUS_CONFIG" ]]; then mv -f "$E2E_PREVIOUS_CONFIG" "$E2E_PROJECT_DIR/supatype.local.config.ts"; fi
    E2E_WROTE_CONFIG="no"
  fi
  if [[ -n "$E2E_LOCK_DIR" ]]; then
    rmdir "$E2E_LOCK_DIR" 2>/dev/null || true
    E2E_LOCK_DIR=""
  fi
}
