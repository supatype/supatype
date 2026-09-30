/**
 * A separate CLI-like process for compose-project-lock.test.ts: the lock is between processes, so
 * the only honest test of it is several real ones competing.
 *
 *   node --import tsx compose-lock-worker.ts <cwd> <mode> [logFile] [holdMs] [startAt]
 *
 * `startAt` (epoch ms) makes every worker reach for the lock at the same instant. Without it they
 * arrive staggered by however long each one took to load, and a lock that is not atomic passes.
 *
 * Modes:
 *   hold     take the lock, log `start <pid>`, hold it for holdMs, log `end <pid>`, release
 *   exit     take the lock, print `acquired`, then `process.exit(0)` without releasing
 *   hang     take the lock, print `acquired`, and never let go (the test SIGKILLs it)
 */
import { appendFileSync } from "node:fs"
import { acquireComposeProjectLock } from "../../src/compose-project-lock.js"

const [cwd, mode, logFile, holdMsArg, startAtArg] = process.argv.slice(2)
if (cwd === undefined || mode === undefined) {
  console.error("usage: compose-lock-worker.ts <cwd> <mode> [logFile] [holdMs]")
  process.exit(2)
}

if (startAtArg !== undefined) {
  const startAt = Number(startAtArg)
  await new Promise((r) => setTimeout(r, Math.max(0, startAt - Date.now() - 5)))
  while (Date.now() < startAt) {
    // Spin the last few ms: timers are too coarse to line processes up any closer.
  }
}

const release = await acquireComposeProjectLock(cwd, `worker ${process.pid}`, {
  pollMs: 20,
  timeoutMs: 60_000,
  onWait: () => undefined,
})

if (mode === "hold") {
  if (logFile === undefined) throw new Error("hold needs a log file")
  appendFileSync(logFile, `start ${process.pid}\n`)
  await new Promise((r) => setTimeout(r, Number(holdMsArg ?? "100")))
  appendFileSync(logFile, `end ${process.pid}\n`)
  release()
} else if (mode === "exit") {
  console.log("acquired")
  process.exit(0)
} else if (mode === "hang") {
  console.log("acquired")
  setInterval(() => undefined, 1 << 30)
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
