import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"

/**
 * A process that starts a worker of its own, as native dev's server starts the Deno functions worker
 * and Deno starts what a function runs (0.9.1 release test, FF12). What a test checks is that
 * stopping the process ends the worker too.
 */
export interface FakeProcessTree {
  dir: string
  /** The parent's script: run it with Node and {@link FakeProcessTree.pidFile} as its argument. */
  script: string
  /** Where the parent writes the worker's pid once the worker runs. */
  pidFile: string
}

const dirs: string[] = []
const started: number[] = []

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A parent whose worker outlives it unless something ends the worker too. */
export function fakeProcessTree(): FakeProcessTree {
  const dir = mkdtempSync(join(tmpdir(), "supatype-process-tree-"))
  dirs.push(dir)
  const script = join(dir, "parent.mjs")
  writeFileSync(
    script,
    [
      'import { spawn } from "node:child_process"',
      'import { writeFileSync } from "node:fs"',
      'import { dirname, join } from "node:path"',
      // Node ends the processes it started when it ends, on Windows through a job object; the Go
      // server and Deno do not, and outside that job (detached, on Windows) the worker outlives its
      // parent as Deno did.
      'const detached = process.platform === "win32"',
      'const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached })',
      "worker.unref()",
      'writeFileSync(join(dirname(process.argv[2]), "parent.pid"), String(process.pid))',
      "writeFileSync(process.argv[2], String(worker.pid))",
      "setInterval(() => {}, 1000)",
      "",
    ].join("\n"),
  )
  return { dir, script, pidFile: join(dir, "worker.pid") }
}

export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

/** The worker's pid, once the parent has written it. */
export async function workerPid(tree: FakeProcessTree): Promise<number> {
  const written = (): boolean => existsSync(tree.pidFile) && readFileSync(tree.pidFile, "utf8") !== ""
  expect(await until(written, 10_000)).toBe(true)
  const pid = Number(readFileSync(tree.pidFile, "utf8"))
  started.push(pid)
  return pid
}

/** Ends what a failing run left running (the worker, and a parent a crash left), then removes the files. */
export function cleanupProcessTrees(): void {
  for (const dir of dirs) {
    const parent = join(dir, "parent.pid")
    if (existsSync(parent)) started.push(Number(readFileSync(parent, "utf8")))
  }
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL")
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
