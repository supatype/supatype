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
#    Supatype ledger, and records the engine versions in `_supatype.migrations.engine_version`.
#    Each push records the version of the engine that made it, and since F24 a candidate build
#    reports `<next minor>-dev+<commit>` (build.sh passes the commit), so every version recorded
#    must be exactly what the train engine's `--version` prints. Anything else was pushed by
#    another engine: a release, or a candidate from another commit.

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
      # One line per database with a ledger: `<container> <db> versions=<v1>,<v2>` (empty while no
      # push has recorded a row). A database without `_supatype.migrations` prints nothing.
      docker exec -i -e PGPASSWORD="$pw" "$c" psql -h 127.0.0.1 -U "$user" -d "$db" -XAtq \
        2>/dev/null >>"$out" <<SQL || true
select to_regclass('_supatype.migrations') is not null as has_ledger \gset
\if :has_ledger
select '$c $db versions=' || coalesce(string_agg(distinct coalesce(engine_version, 'none'), ','), '')
  from _supatype.migrations;
\endif
SQL
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

# Prints one line per database that holds a push made by an engine other than the train's.
check_ledgers() {
  local dir="$1" want
  want="$("$TRAIN_ENGINE_BIN" --version 2>/dev/null | awk '{print $2}')"
  if [[ -z "$want" ]]; then
    echo "the train engine $TRAIN_ENGINE_BIN did not report a version"
    return
  fi
  # Every observation counts, not only the last: rows are only ever added during a suite, and a
  # database dropped before the final poll still had its pushes seen while it lived.
  awk -v want="$want" '
    { sub(/^versions=/, "", $3); n = split($3, vs, ",")
      for (i = 1; i <= n; i++) if (vs[i] != want) bad[$1 "/" $2 " " vs[i]] = 1 }
    END { for (k in bad) { split(k, p, " ")
      print "database " p[1] " was pushed by engine " p[2] ", not the train engine " want } }' \
    "$dir/ledgers.log"
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
