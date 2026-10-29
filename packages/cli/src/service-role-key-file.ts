/**
 * The file native dev and `functions serve` hand the service-role key to the functions worker in.
 *
 * The worker takes the key out of its environment before it imports any function, so no module
 * body can copy it. Both run the worker under `deno run --watch`, which reloads it by evaluating it
 * again in the same process, whose environment the earlier evaluation already took the key out of.
 * The file is still there however that evaluation ended, so the worker reads the key from it
 * (`SUPATYPE_SERVICE_ROLE_KEY_FILE`) on every evaluation and nothing has to be put back.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { hostname } from "node:os"
import { dirname, join, resolve as pathResolve } from "node:path"
import { pidAlive } from "./parent-watch.js"
import { uniqueFileToken } from "./unique-file-token.js"

/** Where native dev keeps the service-role key for the worker it runs: in `.supatype/` under cwd. */
export function devServiceRoleKeyPath(cwd: string): string {
  return join(pathResolve(cwd, ".supatype"), "service-role-key")
}

/**
 * Writes the service-role key to `keyPath`, readable by its owner only where the platform has such
 * permissions. It belongs in `.supatype/`, the CLI's own directory, which `init` adds to
 * `.gitignore`.
 */
export function writeServiceRoleKeyFile(keyPath: string, serviceRoleKey: string): void {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, serviceRoleKey, { encoding: "utf8", mode: 0o600 })
  // The mode above applies only to a file it creates; one left by an earlier run keeps its own.
  chmodSync(keyPath, 0o600)
}

/**
 * Removes `path` when this process exits. A process killed outright leaves it behind, which
 * {@link sweepStaleServeKeyFiles} clears for `functions serve`. A file that cannot go (held open on
 * Windows) stays rather than throwing past the exit listeners after this one.
 */
export function removeOnExit(path: string): void {
  process.once("exit", () => {
    try {
      rmSync(path, { force: true })
    } catch {
      // Nothing is left to report to: the process is exiting.
    }
  })
}

/**
 * {@link writeServiceRoleKeyFile}, removing the file again when this process exits, so the key is
 * on disk only while something that uses it is running.
 */
export function writeServiceRoleKeyFileUntilExit(keyPath: string, serviceRoleKey: string): void {
  writeServiceRoleKeyFile(keyPath, serviceRoleKey)
  removeOnExit(keyPath)
}

/**
 * Which machine and system a serve file was written on. A pid is only meaningful there: WSL and
 * Windows, or a container, can serve one mounted project, and each would read the other's live
 * pids as dead.
 */
const SERVE_HOST_TAG = createHash("sha256").update(`${process.platform}:${hostname()}`).digest("hex").slice(0, 8)

/**
 * Where one `functions serve` keeps its key: a file of its own, since each removes it when it stops
 * while another may still be serving the same project. The name carries this host's tag and,
 * inside `token`, the pid {@link sweepStaleServeKeyFiles} reads back.
 */
export function functionsServeKeyPath(cwd: string, token: string = uniqueFileToken()): string {
  return join(pathResolve(cwd, ".supatype"), `functions-serve-key-${SERVE_HOST_TAG}-${token}`)
}

/** A serve key file's name: `functions-serve-key-<host tag>-<time>-<pid>-<uuid>`. */
const SERVE_KEY_NAME = /^functions-serve-key-([0-9a-f]{8})-\d+-(\d+)-[0-9a-f-]+$/

/**
 * Removes the key files of this host's serves whose process is gone. One killed outright runs no
 * exit listener, and no later serve shares its file name, so its key would stay on disk for good.
 * A file that cannot go (held open on Windows) is left for a later sweep.
 */
export function sweepStaleServeKeyFiles(cwd: string): void {
  const dir = pathResolve(cwd, ".supatype")
  const names = existsSync(dir) ? readdirSync(dir) : []
  for (const name of names) {
    const match = SERVE_KEY_NAME.exec(name)
    if (match?.[1] !== SERVE_HOST_TAG || pidAlive(Number(match[2]))) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Left for the next serve to sweep.
    }
  }
}
