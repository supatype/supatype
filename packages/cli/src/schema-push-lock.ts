/**
 * Advisory lock held while compose schema push runs so realtime can skip WAL
 * decoding without stopping the realtime process (self-host safe).
 *
 * Must stay in sync with:
 *   - packages/realtime/src/schema-push-lock.ts
 *   - supatype-schema-engine (pg_advisory_xact_lock on the same keys)
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import type { SelfHostComposePaths } from "./self-host-compose.js"
import { readEnvValue } from "./env-file.js"

export const SCHEMA_PUSH_LOCK_CLASSID = 872014
export const SCHEMA_PUSH_LOCK_OBJID = 1

function composeBaseArgs(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
): string[] {
  const envFile = resolve(cwd, ".env")
  const args = ["compose", "-p", composeProject, "--project-directory", cwd, "-f", paths.composePath]
  if (existsSync(envFile)) args.push("--env-file", envFile)
  return args
}

function dbExecArgs(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
  psqlArgs: string[],
): string[] {
  const pass = readEnvValue(cwd, "POSTGRES_PASSWORD", "postgres")
  const user = readEnvValue(cwd, "POSTGRES_USER", "supatype_admin")
  const db = readEnvValue(cwd, "POSTGRES_DB", "supatype")
  return [
    ...composeBaseArgs(paths, cwd, composeProject),
    "exec",
    "-T",
    "-e",
    `PGPASSWORD=${pass}`,
    "db",
    "psql",
    "-U",
    user,
    "-d",
    db,
    "-v",
    "ON_ERROR_STOP=1",
    ...psqlArgs,
  ]
}

function schemaPushLockIsHeld(
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
): boolean {
  const args = dbExecArgs(paths, cwd, composeProject, [
    "-tAc",
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = ${SCHEMA_PUSH_LOCK_CLASSID}
         AND objid = ${SCHEMA_PUSH_LOCK_OBJID}
         AND granted
     )`,
  ])
  const result = spawnSync("docker", args, { cwd, encoding: "utf8" })
  return result.status === 0 && result.stdout.trim() === "t"
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
  // The lock is held by a psql session reading from **stdin**, not by `-c … pg_sleep(86400)`.
  //
  // Killing the local `docker` client does not stop the process inside the container: `docker
  // compose exec` does not forward the signal. With a sleeping session that meant every push
  // left a backend holding this advisory lock for 24 hours — so `supatype push` never exited and
  // the next push blocked on it. Observed end-to-end before this change.
  //
  // Closing stdin *does* propagate: psql sees EOF, exits, and the session ends, which is what
  // releases an advisory lock. Deterministic, and it needs no signal to cross the boundary.
  const args = dbExecArgs(paths, cwd, composeProject, ["-f", "-"])

  let stderrBuf = ""
  const holder: ChildProcess = spawn("docker", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  })
  holder.stdin?.write(
    `SELECT pg_advisory_lock(${SCHEMA_PUSH_LOCK_CLASSID}, ${SCHEMA_PUSH_LOCK_OBJID});\n`,
  )
  // Deliberately not ended — the open pipe is what keeps the session, and the lock, alive.
  holder.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (holder.exitCode !== null) {
      const err = stderrBuf.trim() || "lock holder exited"
      throw new Error(`[supatype] Failed to acquire schema-push advisory lock: ${err}`)
    }
    if (schemaPushLockIsHeld(paths, cwd, composeProject)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!schemaPushLockIsHeld(paths, cwd, composeProject)) {
    holder.kill("SIGTERM")
    throw new Error("[supatype] Timed out waiting for schema-push advisory lock")
  }

  try {
    return await fn()
  } finally {
    await releaseHolder(holder, paths, cwd, composeProject)
  }
}

/**
 * End the holder session, then confirm the lock is actually gone.
 *
 * Closing stdin is the mechanism; the check is because a leaked holder is silent and expensive —
 * it blocks every later push. If EOF did not do it, terminate the backend directly.
 */
async function releaseHolder(
  holder: ChildProcess,
  paths: SelfHostComposePaths,
  cwd: string,
  composeProject: string,
): Promise<void> {
  if (holder.exitCode === null) {
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

  if (!schemaPushLockIsHeld(paths, cwd, composeProject)) return

  // Last resort: the session outlived its client. Ending it releases the lock.
  spawnSync(
    "docker",
    dbExecArgs(paths, cwd, composeProject, [
      "-tAc",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND query LIKE '%pg_advisory_lock(${SCHEMA_PUSH_LOCK_CLASSID}, ${SCHEMA_PUSH_LOCK_OBJID})%'`,
    ]),
    { cwd, stdio: "ignore" },
  )
}
