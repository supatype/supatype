#!/usr/bin/env bash
# shellcheck disable=SC2034 # sourced: run-suite.sh and run-all.sh read TRAIN_SUITES.
# The suites the release train runs, and how each one is started. Sourced by run-suite.sh.
#
# Each command runs from the candidate supatype checkout ($TRAIN_SUPATYPE_DIR) unless it changes
# directory itself, with the train's images exported and the train's engine on the host. The list
# is L3 of Pre-Launch-Review-and-Test-Plan.md: every live-stack job in integration.yml, the
# ownership commands, the masking matrix and positioning checks, and the engine's integration
# tests against the train's Postgres.
#
# A suite named here that has no runnable command is a failure, not a skip: the live examples
# (edge-kit, framework-parity, expo-auth) have no automated suite yet, and the train says so on
# every run until they do.

TRAIN_SUITES=(
  ownership
  masking
  positioning
  dev-integration
  compose-smoke
  storage-backend
  realtime
  validation
  kitchen-sink
  supabucks
  blog
  field-conformance
  studio-ui
  zero-to-running
  hook-adapter
  engine-integration
  realtime-tier2
  live-examples
  # Last: the candidate's data-plane-e2e.sh rebuilds storage and realtime under the train's tags
  # (fixed on main, not yet in the stack), and every stack started after it would run those builds.
  data-plane
)

# The engine's own tests build legacy ledgers on purpose (pre-ledger shapes, the old migration
# path), so the "pushed by an engine without the ledger" check does not apply to them.
suite_checks_ledgers() {
  case "$1" in engine-integration) return 1 ;; *) return 0 ;; esac
}

# Suites that drive a browser need Playwright's Chromium installed first.
suite_needs_browser() {
  case "$1" in studio-ui|kitchen-sink) return 0 ;; *) return 1 ;; esac
}

# Prints the shell command for a suite. Runs under `bash -c` from the candidate checkout.
suite_command() {
  local s="tests/integration/scripts"
  case "$1" in
    ownership) echo "OWNERSHIP_PG_PORT=55441 OWNERSHIP_ENGINE_BIN=\"\$TRAIN_ENGINE_BIN\" bash $s/ownership-e2e.sh" ;;
    masking) echo "bash $s/masking-e2e.sh" ;;
    positioning) echo "bash $s/positioning-e2e.sh" ;;
    # --skip-docker-build: the script otherwise rebuilds every image it can find a source for, under
    # the train's own tags, and the stacks after it would run those builds instead of the train's.
    dev-integration) echo "SUPATYPE_PROVIDER=docker bash $s/integration-test.sh --skip-build --skip-docker-build" ;;
    compose-smoke) echo "bash $s/compose-smoke.sh" ;;
    storage-backend) echo "bash $s/storage-backend-e2e.sh" ;;
    realtime) echo "bash $s/realtime-e2e.sh" ;;
    data-plane) echo "bash $s/data-plane-e2e.sh" ;;
    validation) echo "bash $s/validation-e2e.sh" ;;
    kitchen-sink) echo "bash $s/kitchen-sink-e2e.sh" ;;
    supabucks) echo "bash $s/supabucks-e2e.sh" ;;
    blog) echo "bash $s/blog-e2e.sh" ;;
    field-conformance) echo "bash $s/field-conformance.sh" ;;
    studio-ui) echo "bash $s/studio-ui-e2e.sh" ;;
    zero-to-running) echo "SUPATYPE_ZTR_INSTALL=workspace SUPATYPE_ZTR_WORK_ROOT=\"\${TMPDIR:-/tmp}/train-ztr\" bash $s/zero-to-running.sh" ;;
    hook-adapter) echo "bash $s/hook-adapter.sh" ;;
    engine-integration) echo "bash \"\$TRAIN_HARNESS_DIR/scripts/release-train/engine-integration.sh\"" ;;
    realtime-tier2) echo "bash \"\$TRAIN_HARNESS_DIR/scripts/release-train/realtime-tier2.sh\"" ;;
    live-examples) echo "echo 'edge-kit, framework-parity and expo-auth have no automated live suite yet (L3).' >&2; exit 1" ;;
    *) return 1 ;;
  esac
}
