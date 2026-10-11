#!/usr/bin/env bash
# Proof of what ran: every container a suite starts, and every push the engine records.
#
# Sourced by run-suite.sh. Two watchers run beside each suite:
#
# 1. `docker events` records each container created, with its image. Afterwards, every image named
#    supatype/... or ghcr.io/supatype/... must be one of the train's builds (by image ID, so a
#    second tag on a train image counts as the train image). A suite that pulled a published image
#    in place of the build fails, whatever its own result.
# 2. A poller looks into every running train Postgres container, in every database that holds a
#    Supatype ledger, and records whether `_supatype.managed_objects_undo` exists. Only an engine
#    with the rollback ledger creates it, so a database that has `_supatype.migrations` without it
#    was pushed by an older engine.
#
# TODO(F24): once candidate builds carry a pre-release version (0.7.0-rc.<sha>), check
# `_supatype.migrations.engine_version` against the train engine's `--version` instead. The undo
# table is an interim marker: it tells a ledger-era engine from 0.6.0, not one candidate from
# another.

PROV_EVENTS_PID=""
PROV_POLL_PID=""

# Image IDs of every train build, one per line, as prepare.sh recorded them before any suite ran.
# Read from that record rather than from the tags now: a suite that rebuilds an image under a train
# tag (data-plane-e2e.sh builds storage and realtime itself) would otherwise pass as the train.
TRAIN_IDS_FILE="${TRAIN_STATE_DIR:-$HOME/.supatype-train}/image-ids"
record_train_image_ids() {
  local c
  mkdir -p "$(dirname "$TRAIN_IDS_FILE")"
  for c in "${TRAIN_COMPONENTS[@]}"; do
    docker image inspect "$(train_image "$c")" --format '{{.Id}}'
  done >"$TRAIN_IDS_FILE"
}
train_image_ids() { cat "$TRAIN_IDS_FILE"; }

poll_ledgers_once() {
  local out="$1" pg_id c user pw db
  pg_id="$(docker image inspect "$(train_image postgres)" --format '{{.Id}}' 2>/dev/null)" || return 0
  for c in $(docker ps --format '{{.Names}}'); do
    [[ "$(docker inspect "$c" --format '{{.Image}}' 2>/dev/null)" == "$pg_id" ]] || continue
    user="$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')"
    pw="$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')"
    user="${user:-postgres}"
    for db in $(docker exec -e PGPASSWORD="$pw" "$c" psql -h 127.0.0.1 -U "$user" -d postgres -XAtqc \
      "select datname from pg_database where datallowconn and not datistemplate" 2>/dev/null); do
      docker exec -e PGPASSWORD="$pw" "$c" psql -h 127.0.0.1 -U "$user" -d "$db" -XAtqc \
        "select '$c $db ledger=' || (to_regclass('_supatype.migrations') is not null)::text
                || ' undo=' || (to_regclass('_supatype.managed_objects_undo') is not null)::text" \
        2>/dev/null >>"$out" || true
    done
  done
}

start_provenance() {
  local dir="$1"
  : >"$dir/containers.log"
  : >"$dir/ledgers.log"
  docker events --filter type=container --filter event=create \
    --format '{{.Actor.Attributes.image}}|{{.Actor.Attributes.name}}' >"$dir/containers.log" 2>/dev/null &
  PROV_EVENTS_PID=$!
  ( while :; do poll_ledgers_once "$dir/ledgers.log"; sleep 5; done ) &
  PROV_POLL_PID=$!
}

stop_provenance() {
  local dir="$1"
  [[ -n "$PROV_POLL_PID" ]] && kill "$PROV_POLL_PID" 2>/dev/null || true
  [[ -n "$PROV_EVENTS_PID" ]] && kill "$PROV_EVENTS_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  poll_ledgers_once "$dir/ledgers.log"
  PROV_POLL_PID=""
  PROV_EVENTS_PID=""
}

# Prints one line per container that ran something other than a train build.
check_images() {
  local dir="$1" ids image name id
  ids="$(train_image_ids)"
  while IFS='|' read -r image name; do
    [[ -n "$image" ]] || continue
    case "$image" in supatype/*|ghcr.io/supatype/*|docker.io/supatype/*) ;; *) continue ;; esac
    id="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || echo missing)"
    grep -qxF "$id" <<<"$ids" || echo "container $name ran $image, which is not a train build"
  done <"$dir/containers.log"
}

# Prints one line per database whose pushes were made by an engine without the ledger.
check_ledgers() {
  local dir="$1"
  # The last observation of each database decides. The engine's bootstrap creates the migrations
  # table and the undo table in separate transactions, so a poll can land between the two; what
  # matters is the state the push left, not a moment inside it.
  awk '{ state[$1 "/" $2] = $3 " " $4 }
    END { for (db in state) if (state[db] == "ledger=true undo=false")
      print "database " db " was pushed by an engine without the ledger (no _supatype.managed_objects_undo)" }' "$dir/ledgers.log"
}

# The host engine cache must hold the train engine and nothing else: anything else there was
# downloaded, and a suite may have pushed with it.
check_engine_cache() {
  local want got f
  want="$(sha256sum "$TRAIN_ENGINE_BIN" | cut -d' ' -f1)"
  [[ -d "$HOME/.supatype/cache/engine" ]] || return 0
  while IFS= read -r f; do
    got="$(sha256sum "$f" | cut -d' ' -f1)"
    [[ "$got" == "$want" ]] || echo "host engine cache holds $f, which is not the train engine"
  done < <(find "$HOME/.supatype/cache/engine" -type f -name 'supatype-engine-*')
}
