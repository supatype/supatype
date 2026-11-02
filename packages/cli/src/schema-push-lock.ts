/**
 * Advisory lock held while compose schema push runs so realtime can skip WAL
 * decoding without stopping the realtime process (self-host safe).
 *
 * Must stay in sync with:
 *   - packages/realtime/src/schema-push-lock.ts
 *   - supatype-schema-engine (pg_advisory_xact_lock on the same keys)
 */

import type { ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { askDocker, DOCKER_EXEC_TIMEOUT_MS, spawnDocker } from "./docker-exec.js"
import type { SelfHostComposePaths } from "./self-host-compose.js"
import { composeDbPsql } from "./compose-db-psql.js"
import type { DockerEnv } from "./docker-env.js"

export const SCHEMA_PUSH_LOCK_CLASSID = 872014
export const SCHEMA_PUSH_LOCK_OBJID = 1

/** `psql` in the stack's `db` container, stopping at the first error. */
function dbExec(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  psqlArgs: string[],
): DockerEnv {
  const stack = { project: composeProject, composePath: paths.composePath }
  return composeDbPsql(cwd, stack, ["-v", "ON_ERROR_STOP=1", ...psqlArgs])
}

/** Whether the schema-push advisory lock is held by any session. */
async function schemaPushLockIsHeld(paths: SelfHostComposePaths, cwd: string, composeProject: string): Promise<boolean> {
  const { args, env } = dbExec(paths, cwd, composeProject, [
    "-tAc",
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = ${SCHEMA_PUSH_LOCK_CLASSID}
         AND objid = ${SCHEMA_PUSH_LOCK_OBJID}
         AND granted
     )`,
  ])
  const result = await askDocker(args, { cwd, env, timeoutMs: DOCKER_EXEC_TIMEOUT_MS })
  return result.status === 0 && result.stdout.trim() === "t"
}

/** The holder session and what it has said on stderr so far. */
interface LockHolder {
  process: ChildProcess
  stderr: () => string
}

/**
 * Start the psql session that takes the lock. It is held by a session reading from **stdin**, not
 * by `-c … pg_sleep(86400)`.
 *
 * Killing the local `docker` client does not stop the process inside the container: `docker
 * compose exec` does not forward the signal. With a sleeping session that meant every push
 * left a backend holding this advisory lock for 24 hours, so `supatype push` never exited and
 * the next push blocked on it. Observed end-to-end before this change.
 *
 * Closing stdin *does* propagate: psql sees EOF, exits, and the session ends, which is what
 * releases an advisory lock. Deterministic, and it needs no signal to cross the boundary. So this
 * process has no limit: it lives exactly as long as the push, and its owner ends it.
 */
function startLockHolder(paths: SelfHostComposePaths, cwd: string, composeProject: string): LockHolder {
  const { args, env } = dbExec(paths, cwd, composeProject, ["-f", "-"])
  let stderrBuf = ""
  const holder = spawnDocker(args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  holder.stdin?.write(`SELECT pg_advisory_lock(${SCHEMA_PUSH_LOCK_CLASSID}, ${SCHEMA_PUSH_LOCK_OBJID});\n`)
  // Deliberately not ended: the open pipe is what keeps the session, and the lock, alive.
  holder.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })
  return { process: holder, stderr: () => stderrBuf }
}

/** Wait up to 30 seconds for the holder to have the lock; throws, having stopped it, when it does not. */
async function awaitLockHeld(holder: LockHolder, paths: SelfHostComposePaths, cwd: string, composeProject: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (holder.process.exitCode !== null) {
      throw new Error(`[supatype] Failed to acquire schema-push advisory lock: ${holder.stderr().trim() || "lock holder exited"}`)
    }
    if (await schemaPushLockIsHeld(paths, cwd, composeProject)) return
    await sleep(200)
  }
  if (await schemaPushLockIsHeld(paths, cwd, composeProject)) return
  holder.process.kill("SIGTERM")
  throw new Error("[supatype] Timed out waiting for schema-push advisory lock")
}

/**
 * Hold a session advisory lock for the duration of `fn` via a background
 * `psql` inside the compose db container. Killing the holder releases the lock.
 */
export async function withComposeSchemaPushLock<T>(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  fn: () => Promise<T>,
): Promise<T> {
  const holder = startLockHolder(paths, cwd, composeProject)
  await awaitLockHeld(holder, paths, cwd, composeProject)
  try {
    return await fn()
  } finally {
    await releaseHolder(holder.process, paths, cwd, composeProject)
  }
}

/** Close the holder's stdin and wait for it to exit, killing it after five seconds. */
async function endHolder(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null) return
  holder.stdin?.end()
  await new Promise<void>((resolveDone) => {
    const t = setTimeout(() => {
      holder.kill("SIGKILL")
      resolveDone()
    }, 5000)
    holder.once("exit", () => {
      clearTimeout(t)
      resolveDone()
    })
  })
}

/**
 * End the holder session, then confirm the lock is actually gone.
 *
 * Closing stdin is the mechanism; the check is because a leaked holder is silent and expensive,
 * it blocks every later push. If EOF did not do it, terminate the backend directly.
 */
async function releaseHolder(
  holder: ChildProcess,
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
): Promise<void> {
  await endHolder(holder)
  if (!(await schemaPushLockIsHeld(paths, cwd, composeProject))) return

  // Last resort: the session outlived its client. Ending it releases the lock.
  const terminate = dbExec(paths, cwd, composeProject, [
    "-tAc",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND query LIKE '%pg_advisory_lock(${SCHEMA_PUSH_LOCK_CLASSID}, ${SCHEMA_PUSH_LOCK_OBJID})%'`,
  ])
  await askDocker(terminate.args, { cwd, env: terminate.env, timeoutMs: DOCKER_EXEC_TIMEOUT_MS })
}
