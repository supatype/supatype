import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  acquireComposeProjectLock,
  composeProjectLockPath,
  readComposeProjectLock,
  withComposeProjectLock,
  type ComposeProjectLock,
} from "../src/compose-project-lock.js"

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/compose-lock-worker.ts")

function writeLock(cwd: string, pid: number, holder = "someone else"): void {
  const path = composeProjectLockPath(cwd)
  mkdirSync(dirname(path), { recursive: true })
  const lock: ComposeProjectLock = { version: 1, pid, holder, startedAt: new Date().toISOString() }
  writeFileSync(path, JSON.stringify(lock))
}

/** A process that is alive for as long as the test wants, so its pid reads as a live holder. */
function liveProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" })
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" })
  return Number(r.stdout.trim())
}

function runWorker(cwd: string, mode: string, ...rest: string[]): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", WORKER, cwd, mode, ...rest], {
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) r(child.exitCode)
    else child.once("exit", (code) => r(code))
  })
}

function printed(child: ChildProcess, text: string): Promise<void> {
  return new Promise((r, reject) => {
    let out = ""
    let err = ""
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString()
      if (out.includes(text)) r()
    })
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()))
    child.once("exit", () => reject(new Error(`worker exited before printing "${text}": ${err}`)))
  })
}

/** True when the promise is still pending after `ms`. */
async function stillPending(p: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol("pending")
  const winner = await Promise.race([p, new Promise((r) => setTimeout(() => r(marker), ms))])
  return winner === marker
}

/** Every `start` is followed by the same pid's `end` before anyone else's `start`. */
function assertNoOverlap(logFile: string, expectedHolds: number): void {
  const lines = readFileSync(logFile, "utf8").trim().split("\n")
  expect(lines).toHaveLength(expectedHolds * 2)
  for (let i = 0; i < lines.length; i += 2) {
    const [startKind, startPid] = lines[i]!.split(" ")
    const [endKind, endPid] = lines[i + 1]!.split(" ")
    expect(startKind).toBe("start")
    expect(endKind).toBe("end")
    expect(endPid).toBe(startPid)
  }
}

describe("compose-project-lock", () => {
  let cwd: string
  const children: ChildProcess[] = []

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "supatype-compose-lock-"))
  })

  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL")
    rmSync(cwd, { recursive: true, force: true })
  })

  describe("in one process", () => {
    it("writes who holds it, and removes the file on release", async () => {
      const release = await acquireComposeProjectLock(cwd, "supatype push")
      const lock = readComposeProjectLock(cwd)
      expect(lock?.pid).toBe(process.pid)
      expect(lock?.holder).toBe("supatype push")

      release()
      expect(existsSync(composeProjectLockPath(cwd))).toBe(false)
    })

    it("is reentrant, and only the outermost release lets go", async () => {
      const outer = await acquireComposeProjectLock(cwd, "supatype push")
      // `push` → the shared schema-push path. Must not wait on itself.
      const inner = await acquireComposeProjectLock(cwd, "supatype dev (applying a schema change)", {
        timeoutMs: 500,
      })
      expect(readComposeProjectLock(cwd)?.holder).toBe("supatype push")

      inner()
      expect(existsSync(composeProjectLockPath(cwd))).toBe(true)
      outer()
      expect(existsSync(composeProjectLockPath(cwd))).toBe(false)
    })

    it("treats a second call to the same release as a no-op", async () => {
      const outer = await acquireComposeProjectLock(cwd, "a")
      const inner = await acquireComposeProjectLock(cwd, "b")
      inner()
      inner()
      expect(existsSync(composeProjectLockPath(cwd))).toBe(true)
      outer()
    })

    it("releases when the wrapped function throws", async () => {
      await expect(
        withComposeProjectLock(cwd, "supatype push", async () => {
          throw new Error("boom")
        }),
      ).rejects.toThrow("boom")
      expect(existsSync(composeProjectLockPath(cwd))).toBe(false)
    })
  })

  describe("against another holder", () => {
    it("waits while the holder is alive, says who it is waiting for, and goes once it lets go", async () => {
      const holder = liveProcess()
      children.push(holder)
      writeLock(cwd, holder.pid!, "supatype dev (applying a schema change)")

      const waitedFor: string[] = []
      const acquiring = acquireComposeProjectLock(cwd, "supatype push", {
        pollMs: 20,
        onWait: (l) => waitedFor.push(l.holder),
      })
      expect(await stillPending(acquiring, 300)).toBe(true)
      expect(waitedFor).toEqual(["supatype dev (applying a schema change)"])

      rmSync(composeProjectLockPath(cwd))
      const release = await acquiring
      expect(readComposeProjectLock(cwd)?.pid).toBe(process.pid)
      release()
    })

    it("takes over once the holder dies without releasing", async () => {
      const holder = liveProcess()
      children.push(holder)
      writeLock(cwd, holder.pid!)

      const acquiring = acquireComposeProjectLock(cwd, "supatype push", { pollMs: 20, onWait: () => undefined })
      expect(await stillPending(acquiring, 200)).toBe(true)

      holder.kill("SIGKILL")
      await exited(holder)
      const release = await acquiring
      expect(readComposeProjectLock(cwd)?.pid).toBe(process.pid)
      release()
    })

    it("reclaims a lock left by a process that is already gone, without waiting", async () => {
      writeLock(cwd, deadPid())
      const release = await acquireComposeProjectLock(cwd, "supatype push", { timeoutMs: 1000 })
      expect(readComposeProjectLock(cwd)?.pid).toBe(process.pid)
      release()
    })

    it("does not reclaim a lock file that is still being written", async () => {
      const path = composeProjectLockPath(cwd)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "")

      const acquiring = acquireComposeProjectLock(cwd, "supatype push", { pollMs: 20, onWait: () => undefined })
      expect(await stillPending(acquiring, 300)).toBe(true)
      rmSync(path)
      ;(await acquiring)()
    })

    it("reclaims an unreadable lock file once it is clearly abandoned", async () => {
      const path = composeProjectLockPath(cwd)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "{ not json")
      const old = new Date(Date.now() - 60_000)
      utimesSync(path, old, old)

      const release = await acquireComposeProjectLock(cwd, "supatype push", { timeoutMs: 1000 })
      expect(readComposeProjectLock(cwd)?.pid).toBe(process.pid)
      release()
    })

    // The race the takeover guard exists for: two waiters both see the same dead holder, the first
    // unlinks and re-creates the lock, and the second's unlink then deletes that fresh lock, so both
    // hold it. Stress runs hit it about once in fifteen rounds of twelve processes without the
    // guard, which is too rare to catch in CI, so these pin the guard's contract directly.
    it("leaves a stale lock alone while another process is mid-takeover", async () => {
      writeLock(cwd, deadPid())
      const guard = `${composeProjectLockPath(cwd)}.takeover`
      writeFileSync(guard, "12345")

      const acquiring = acquireComposeProjectLock(cwd, "supatype push", { pollMs: 20, onWait: () => undefined })
      expect(await stillPending(acquiring, 300)).toBe(true)
      expect(readComposeProjectLock(cwd)).not.toBeNull()

      rmSync(guard)
      ;(await acquiring)()
    })

    it("clears a takeover guard left behind by a crash", async () => {
      writeLock(cwd, deadPid())
      const guard = `${composeProjectLockPath(cwd)}.takeover`
      writeFileSync(guard, "12345")
      const old = new Date(Date.now() - 60_000)
      utimesSync(guard, old, old)

      const release = await acquireComposeProjectLock(cwd, "supatype push", { timeoutMs: 2000, pollMs: 20 })
      expect(readComposeProjectLock(cwd)?.pid).toBe(process.pid)
      expect(existsSync(guard)).toBe(false)
      release()
    })

    it("times out naming the holder and the file to delete", async () => {
      const holder = liveProcess()
      children.push(holder)
      writeLock(cwd, holder.pid!, "supatype dev (starting the stack)")

      await expect(
        acquireComposeProjectLock(cwd, "supatype push", { timeoutMs: 200, pollMs: 20, onWait: () => undefined }),
      ).rejects.toThrow(
        new RegExp(`supatype dev \\(starting the stack\\) \\(pid ${holder.pid}\\).*compose\\.lock`),
      )
    })

    it("never deletes a lock another process holds when releasing its own reference", async () => {
      const release = await acquireComposeProjectLock(cwd, "supatype push")
      const holder = liveProcess()
      children.push(holder)
      // Someone replaced the file (by hand, say). Our release must leave theirs alone.
      writeLock(cwd, holder.pid!)
      release()
      expect(readComposeProjectLock(cwd)?.pid).toBe(holder.pid)
    })
  })

  describe("between real processes", () => {
    it("lets only one process hold it at a time", async () => {
      const log = join(cwd, "holds.log")
      writeFileSync(log, "")
      const startAt = String(Date.now() + 3000)
      const workers = Array.from({ length: 5 }, () => runWorker(cwd, "hold", log, "150", startAt))
      children.push(...workers)

      const codes = await Promise.all(workers.map(exited))
      expect(codes).toEqual([0, 0, 0, 0, 0])
      assertNoOverlap(log, 5)
      expect(existsSync(composeProjectLockPath(cwd))).toBe(false)
    }, 60_000)

    it("keeps them exclusive when several reclaim the same dead holder's lock at once", async () => {
      writeLock(cwd, deadPid())
      const log = join(cwd, "holds.log")
      writeFileSync(log, "")
      const startAt = String(Date.now() + 3000)
      const workers = Array.from({ length: 6 }, () => runWorker(cwd, "hold", log, "100", startAt))
      children.push(...workers)

      const codes = await Promise.all(workers.map(exited))
      expect(codes).toEqual([0, 0, 0, 0, 0, 0])
      assertNoOverlap(log, 6)
    }, 60_000)

    it("is released by a process that exits without releasing it", async () => {
      const worker = runWorker(cwd, "exit")
      children.push(worker)
      await printed(worker, "acquired")
      expect(await exited(worker)).toBe(0)
      expect(existsSync(composeProjectLockPath(cwd))).toBe(false)
    }, 30_000)

    it("makes this process wait for a live holder in another process, and recovers when it is killed", async () => {
      const worker = runWorker(cwd, "hang")
      children.push(worker)
      await printed(worker, "acquired")
      expect(readComposeProjectLock(cwd)?.pid).toBe(worker.pid)

      const acquiring = acquireComposeProjectLock(cwd, "supatype push", { pollMs: 20, onWait: () => undefined })
      expect(await stillPending(acquiring, 300)).toBe(true)

      // SIGKILL runs no exit hook: the file stays behind, and only the dead pid frees it.
      worker.kill("SIGKILL")
      await exited(worker)
      const release = await acquiring
      expect(readComposeProjectLock(cwd)?.pid).toBe(process.pid)
      release()
    }, 30_000)
  })
})
