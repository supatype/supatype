import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { functionsServeKeyPath, removeOnExit, sweepStaleServeKeyFiles } from "../src/service-role-key-file.js"

/**
 * The service-role key file `functions serve` writes. Two serves of one project shared one, so the
 * first to stop deleted the key under the other. Named apart, a serve that is killed outright
 * leaves a file nothing ever overwrote, so a later serve sweeps it.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-serve-"))
  dirs.push(cwd)
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  return cwd
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString()
  return Number(pid)
}

describe("functions serve key files", () => {
  it("are named apart for each serve", () => {
    const cwd = project()
    const first = functionsServeKeyPath(cwd)
    expect(first).not.toBe(functionsServeKeyPath(cwd))
    expect(first.startsWith(join(cwd, ".supatype"))).toBe(true)
  })

  it("left by a serve that is gone are removed, and a running serve's are kept", () => {
    const cwd = project()
    const gone = functionsServeKeyPath(cwd, `1-${deadPid()}-a1b2`)
    const running = functionsServeKeyPath(cwd, `1-${process.pid}-c3d4`)
    for (const path of [gone, running]) writeFileSync(path, "x")
    sweepStaleServeKeyFiles(cwd)
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(running)).toBe(true)
  })

  it("of a serve on another machine or system sharing the project are kept", () => {
    // A pid means nothing across WSL and Windows, or a container, serving one mounted project.
    const cwd = project()
    const elsewhere = join(cwd, ".supatype", `functions-serve-key-00000000-1-${deadPid()}-e5f6`)
    writeFileSync(elsewhere, "x")
    sweepStaleServeKeyFiles(cwd)
    expect(existsSync(elsewhere)).toBe(true)
  })

  it("that cannot be swept do not stop the serve", () => {
    const cwd = project()
    const keyPath = functionsServeKeyPath(cwd, `1-${deadPid()}-a1b2`)
    // A directory with something in it: rmSync without recursive refuses it, as Windows refuses a
    // file held open.
    mkdirSync(join(keyPath, "inside"), { recursive: true })
    expect(() => sweepStaleServeKeyFiles(cwd)).not.toThrow()
  })

  it("that cannot be removed on exit do not stop the other exit listeners", () => {
    const cwd = project()
    // A directory with something in it: rmSync without recursive refuses it.
    const stuck = join(cwd, "stuck")
    mkdirSync(join(stuck, "inside"), { recursive: true })
    const before = process.listeners("exit")
    removeOnExit(stuck)
    const added = process.listeners("exit").filter((listener) => !before.includes(listener))
    for (const listener of added) {
      process.removeListener("exit", listener)
      expect(() => listener.call(process, 0)).not.toThrow()
    }
  })
})
