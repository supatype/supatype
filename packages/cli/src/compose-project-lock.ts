/**
 * One CLI process at a time drives a project's Compose stack.
 *
 * `supatype dev` keeps watching the schema and pushes on every edit, and `supatype push` or `diff`
 * run in another terminal do the same work: rewrite `.env` and the compose file, `up -d db`,
 * `compose run schema-engine`. Two of those at once put two `docker compose` invocations on the
 * same `db` container, and the one that loses the recreate fails with
 * `The container name ".../<project>-db-1" is already in use`. The Postgres advisory lock in
 * `schema-push-lock.ts` does not help: it is taken inside the engine run, after compose has
 * already raced.
 *
 * So this is a host-side lock file, `.supatype/compose.lock`, held around each of those
 * sequences. A second process waits for it rather than failing, and says what it is waiting on.
 *
 * Reentrant within a process (`push` goes through the shared schema-push path, which takes it
 * too). It does not serialize concurrent callers inside one process; the dev watcher already
 * queues its own pushes.
 */

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const LOCK_VERSION = 1 as const
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_MS = 250
const WAIT_NOTICE_MS = 5000
/**
 * A lock file that exists but does not parse is one being written right now (`wx` creates it
 * empty, then writes), unless it has been like that for longer than this.
 */
const UNREADABLE_GRACE_MS = 5000
/** A takeover guard is held for a read and an unlink; one older than this was left by a crash. */
const TAKEOVER_STALE_MS = 10_000

export interface ComposeProjectLock {
  version: typeof LOCK_VERSION
  pid: number
  /** What the holder is doing, e.g. "supatype push". Shown to whoever is waiting. */
  holder: string
  startedAt: string
}

export interface ComposeProjectLockOptions {
  timeoutMs?: number
  pollMs?: number
  /** Called while waiting, at most every few seconds. Defaults to a console line. */
  onWait?: (lock: ComposeProjectLock) => void
}

export function composeProjectLockPath(cwd: string): string {
  return resolve(cwd, ".supatype/compose.lock")
}

export function readComposeProjectLock(cwd: string): ComposeProjectLock | null {
  return readLockFile(composeProjectLockPath(cwd))
}

function readLockFile(path: string): ComposeProjectLock | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ComposeProjectLock
    if (data.version !== LOCK_VERSION || typeof data.pid !== "number") return null
    return data
  } catch {
    return null
  }
}

function fileAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists, it just belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Create the file only if it does not exist. False when someone else got there first. */
function createExclusive(path: string, contents: string): boolean {
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, contents, { flag: "wx" })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false
    throw e
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}

/**
 * Remove a lock whose holder is gone, without removing a fresh one by mistake.
 *
 * Two waiters can both see the same dead holder. If both simply unlinked, the second unlink could
 * delete the lock the first had just created, and both would believe they held it. So the check
 * and the unlink happen under a short-lived guard file, and the lock is re-read under it.
 */
function removeIfStillStale(path: string, isStale: (lock: ComposeProjectLock | null) => boolean): boolean {
  const guard = `${path}.takeover`
  if (!createExclusive(guard, String(process.pid))) {
    const age = fileAgeMs(guard)
    if (age !== null && age > TAKEOVER_STALE_MS) unlinkQuietly(guard)
    return false
  }
  try {
    if (!isStale(readLockFile(path))) return false
    unlinkQuietly(path)
    return true
  } finally {
    unlinkQuietly(guard)
  }
}

const heldDepth = new Map<string, number>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // `process.exit` from a fatal error or the dev shutdown handler skips every `finally`.
  process.on("exit", () => {
    for (const path of heldDepth.keys()) removeIfOurs(path)
    heldDepth.clear()
  })
}

function removeIfOurs(path: string): void {
  const lock = readLockFile(path)
  if (lock?.pid === process.pid) unlinkQuietly(path)
}

function defaultOnWait(lock: ComposeProjectLock): void {
  console.log(`[supatype] Waiting for ${lock.holder} (pid ${lock.pid}) to finish with the Compose stack...`)
}

/**
 * Take the project's Compose lock, waiting for another process to release it. Returns the release
 * function; calling it more than once is harmless.
 */
export async function acquireComposeProjectLock(
  cwd: string,
  holder: string,
  opts: ComposeProjectLockOptions = {},
): Promise<() => void> {
  const path = composeProjectLockPath(cwd)
  const release = onceRelease(path)

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const onWait = opts.onWait ?? defaultOnWait
  const deadline = Date.now() + timeoutMs
  let lastNotice = 0

  const payload: ComposeProjectLock = {
    version: LOCK_VERSION,
    pid: process.pid,
    holder,
    startedAt: new Date().toISOString(),
  }
  const contents = `${JSON.stringify(payload, null, 2)}\n`

  const isStale = (lock: ComposeProjectLock | null): boolean => {
    if (lock === null) {
      const age = fileAgeMs(path)
      return age !== null && age > UNREADABLE_GRACE_MS
    }
    // Our own pid is a live hold only while `heldDepth` says so; otherwise it is a file this
    // process left behind (a previous run that reused the pid, say).
    if (lock.pid === process.pid) return !heldDepth.has(path)
    return !isPidAlive(lock.pid)
  }

  for (;;) {
    // Checked on every pass, not only on entry: another caller in this process may have been
    // waiting on the same holder and claimed the lock while this one slept.
    const depth = heldDepth.get(path)
    if (depth !== undefined) {
      heldDepth.set(path, depth + 1)
      return release
    }
    if (createExclusive(path, contents)) break

    const existing = readLockFile(path)
    // Straight back round after a reclaim. Otherwise someone else is mid-takeover: sleep like any
    // other wait, or this loop never yields and spins a core until they finish.
    if (isStale(existing) && removeIfStillStale(path, isStale)) continue

    if (Date.now() >= deadline) {
      const who = existing ? `${existing.holder} (pid ${existing.pid})` : "another process"
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${who} to release ${path}. ` +
          "If that process is no longer running, delete the file and try again.",
      )
    }

    if (existing && !isStale(existing) && Date.now() - lastNotice >= WAIT_NOTICE_MS) {
      onWait(existing)
      lastNotice = Date.now()
    }
    await sleep(pollMs)
  }

  heldDepth.set(path, 1)
  installExitHook()
  return release
}

function onceRelease(path: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const depth = heldDepth.get(path)
    if (depth === undefined) return
    if (depth > 1) {
      heldDepth.set(path, depth - 1)
      return
    }
    heldDepth.delete(path)
    removeIfOurs(path)
  }
}

/** Run `fn` holding the project's Compose lock. */
export async function withComposeProjectLock<T>(
  cwd: string,
  holder: string,
  fn: () => Promise<T>,
  opts?: ComposeProjectLockOptions,
): Promise<T> {
  const release = await acquireComposeProjectLock(cwd, holder, opts)
  try {
    return await fn()
  } finally {
    release()
  }
}
