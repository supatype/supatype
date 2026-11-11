/**
 * A home folder of its own for every test file, removed after it (vitest `setupFiles`).
 *
 * The CLI keeps per-machine state under `~/.supatype`: the FF26 init port registry and native dev's
 * state in `projects/`, downloaded binaries in `cache/`, cloud credentials. Every path goes through
 * `os.homedir()`, which reads USERPROFILE on Windows and HOME elsewhere. Tests that scaffold a
 * project wrote real `init-ports.json` records into the developer's own home, and
 * a test reading the registry saw records other tests running beside it had just written.
 *
 * Set on `process.env` rather than stubbed, so every CLI a test spawns inherits it too, and a test
 * that stubs and restores its own env lands back here, not on the real home.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

/**
 * The developer's real home, before it is replaced, for reading only: a test that runs a binary
 * the CLI already downloaded (`CACHED_PG_BIN`) finds it there. Kept on the first run, so a second
 * evaluation of this file in the same process cannot record the temp folder as the real one.
 */
export const REAL_HOME_ENV = "SUPATYPE_TEST_REAL_HOME"
process.env[REAL_HOME_ENV] ??= homedir()

const home = mkdtempSync(join(tmpdir(), "supatype-test-home-"))
process.env["HOME"] = home
process.env["USERPROFILE"] = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})
