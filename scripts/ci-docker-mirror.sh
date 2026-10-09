#!/usr/bin/env bash
# Point the runner's Docker daemon at mirror.gcr.io, Google's public Docker Hub mirror.
#
# Docker Hub pulls are rate-limited: anonymously per runner IP, and logged in per account, where
# every parallel CI job shares the one hourly budget. Pulls served by the mirror count against
# neither. An image the mirror does not hold (it caches popular Docker Hub images, not all of
# them) is a miss the daemon answers by pulling from Docker Hub itself, with the job's login.
#
# The daemon also moves to the containerd image store. The classic store sends the Docker Hub
# login to every docker.io endpoint, mirrors included; mirror.gcr.io rejects those credentials
# ("unauthorized: authentication failed"), and the daemon then falls back to Docker Hub, so with a
# login in place the classic store never pulled through the mirror at all. The containerd store
# keeps the login for Docker Hub and asks the mirror anonymously.
#
# The mirror needs no secrets, so this runs in fork and Dependabot jobs too. It is an
# optimisation: anything that goes wrong is a warning and the job pulls from Docker Hub as before.
# It restarts the daemon, so it must run before a job starts any container.
#
# On Linux it edits the runner's own daemon. On macOS Docker runs inside a Colima VM, started by an
# earlier step, and the same edit is made to the daemon in the VM through `colima ssh`. Anywhere
# else, or on macOS without a running Colima, the step says so and does nothing. Runs under bash
# 3.2 as well (no ${var,,}, no mapfile).
set -uo pipefail

mirror="https://mirror.gcr.io"
daemon_json=/etc/docker/daemon.json

case "$(uname -s)" in
  Linux)
    as_root() { sudo "$@"; }
    restart_docker() { sudo systemctl restart docker; }
    wait_tries=30
    ;;
  Darwin)
    if ! command -v colima >/dev/null 2>&1 || ! colima status >/dev/null 2>&1; then
      echo "Docker Hub mirror: skipped on macOS, Colima is not running."
      exit 0
    fi
    as_root() { colima ssh -- sudo "$@"; }
    restart_docker() { colima ssh -- sudo sh -c 'systemctl restart docker || service docker restart'; }
    # The VM's daemon, and the socket Colima forwards to it, take longer to come back.
    wait_tries=60
    ;;
  *)
    echo "Docker Hub mirror: skipped on $(uname -s)."
    exit 0
    ;;
esac

mirrors() {
  docker info --format '{{json .RegistryConfig.Mirrors}}' 2>/dev/null
}

# "true" when the daemon keeps images in containerd, which is what makes the mirror usable with a login.
containerd_store() {
  case "$(docker info --format '{{json .DriverStatus}}' 2>/dev/null)" in
    *io.containerd.snapshotter*) echo true ;;
    *) echo false ;;
  esac
}

case "$(mirrors)" in
  *"$mirror"*)
    if [ "$(containerd_store)" = true ]; then
      echo "Docker Hub mirror: $mirror already configured, with the containerd image store."
      exit 0
    fi
    ;;
esac

wait_for_daemon() {
  local i
  for i in $(seq 1 "$wait_tries"); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

backup=$(mktemp)
had_config=0
if as_root test -f "$daemon_json"; then
  had_config=1
  as_root cat "$daemon_json" >"$backup"
fi

# Merge into whatever the image already configures rather than replacing it.
merged=$(python3 - "$backup" "$mirror" <<'PY'
import json, sys
path, mirror = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        text = f.read()
    cfg = json.loads(text) if text.strip() else {}
except FileNotFoundError:
    cfg = {}
mirrors = cfg.get("registry-mirrors") or []
if mirror not in mirrors:
    mirrors.append(mirror)
cfg["registry-mirrors"] = mirrors
features = cfg.get("features") or {}
features["containerd-snapshotter"] = True
cfg["features"] = features
print(json.dumps(cfg, indent=2))
PY
) || {
  echo "::warning::Docker Hub mirror not configured: could not read $daemon_json; pulling from Docker Hub"
  rm -f "$backup"
  exit 0
}

restore() {
  if [ "$had_config" = 1 ]; then
    as_root tee "$daemon_json" <"$backup" >/dev/null
  else
    as_root rm -f "$daemon_json"
  fi
  restart_docker && wait_for_daemon
}

if ! { as_root mkdir -p "$(dirname "$daemon_json")" \
  && printf '%s\n' "$merged" | as_root tee "$daemon_json" >/dev/null \
  && restart_docker \
  && wait_for_daemon; }; then
  # A daemon that does not come back would fail every later step, which the mirror must never do.
  if restore; then
    echo "::warning::Docker Hub mirror not configured: the daemon did not restart with it; restored the previous config and pulling from Docker Hub"
  else
    echo "::warning::Docker Hub mirror not configured, and the Docker daemon did not come back after restoring its config"
  fi
  rm -f "$backup"
  exit 0
fi
rm -f "$backup"

active=$(mirrors)
store=$(containerd_store)
case "$active" in
  *"$mirror"*)
    if [ "$store" = true ]; then
      echo "Docker Hub mirror: $mirror active (daemon mirrors: $active; containerd image store)."
    else
      echo "::warning::Docker Hub mirror configured but the daemon kept the classic image store, which sends the Docker Hub login to the mirror; logged-in pulls will bypass it"
    fi
    ;;
  *)
    echo "::warning::Docker Hub mirror not active after the restart (daemon mirrors: ${active:-unknown}); pulling from Docker Hub"
    ;;
esac
exit 0
