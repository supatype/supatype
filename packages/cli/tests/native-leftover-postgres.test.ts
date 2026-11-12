import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NativeDevState } from "../src/native-leftover-postgres.js"
import { freePort } from "./support/ports.js"

/**
 * 0.9.2 release test (FF12 remainder): a forced stop of native dev (Windows `taskkill /F` of the
 * CLI, Linux closing its terminal) left the project's Postgres running, and the next `supatype dev`
 * refused "Port 54341 is already in use. Another Postgres instance may be running." about its own.
 */

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { claimNativeDevPorts } = await import("../src/commands/dev.js")

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A listener on a free port, standing in for a Postgres that holds it. */
async function heldPort(): Promise<number> {
  const port = await freePort()
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done))
  servers.push(server)
  return port
}

/** A project's state directory. */
function stateDir(): NativeDevState {
  const root = mkdtempSync(join(tmpdir(), "supatype-leftover-pg-"))
  roots.push(root)
  return { dataDir: join(root, "data"), pidDir: join(root, "pid") }
}

/**
 * A project whose data directory has a postmaster.pid naming `pid`, `dir` and `port`, laid out as
 * Postgres writes it: the data directory with forward slashes, whatever the platform.
 */
function project(postmaster: { pid: number; port: number; dir?: string }): NativeDevState {
  const state = stateDir()
  mkdirSync(state.dataDir, { recursive: true })
  const dir = (postmaster.dir ?? state.dataDir).replaceAll("\\", "/")
  const lines = [postmaster.pid, dir, "1731200000", postmaster.port, "", "localhost", "  1234", "ready"]
  writeFileSync(join(state.dataDir, "postmaster.pid"), `${lines.join("\n")}\n`)
  return state
}

/** Writes the pid file a native dev of the project keeps, naming `pid`. */
function devPid(state: NativeDevState, pid: number): NativeDevState {
  mkdirSync(state.pidDir, { recursive: true })
  writeFileSync(join(state.pidDir, "dev.pid"), String(pid))
  return state
}

/** A pid nothing runs as: odd, so never a Windows pid, and at the top of Linux's range. */
const GONE = 2 ** 22 - 3

/** Native dev's port check for `postgres` and `state`, every other port free: the leftover it found. */
async function check(postgres: number, state: NativeDevState): Promise<number | null> {
  const ports = { postgres, server: await freePort(), postgrest: await freePort(), realtime: await freePort() }
  const claim = await claimNativeDevPorts(ports, state)
  claim.postgrest.release()
  return claim.leftoverPostgres
}

/** The refusal for Postgres's `port`. */
const refusal = (port: number): RegExp => new RegExp(`Port ${port} is already in use[\\s\\S]*Another Postgres instance`)

describe("native dev's port check and this project's own Postgres", () => {
  it("lets a dev through when the port is held by this project's own Postgres, left by a dev that is gone", async () => {
    const postgres = await heldPort()
    await expect(check(postgres, project({ pid: process.pid, port: postgres }))).resolves.toBe(process.pid)
  })

  it("lets it through when the dev that started that Postgres left its pid file behind", async () => {
    const postgres = await heldPort()
    await expect(check(postgres, devPid(project({ pid: process.pid, port: postgres }), GONE))).resolves.toBe(process.pid)
  })

  it("refuses while a dev of this project still runs: its Postgres is that dev's", async () => {
    const postgres = await heldPort()
    const own = devPid(project({ pid: process.pid, port: postgres }), process.ppid)
    await expect(check(postgres, own)).rejects.toThrow(refusal(postgres))
  })

  it("refuses a postmaster.pid naming another data directory, as a copied one does", async () => {
    const postgres = await heldPort()
    const copied = project({ pid: process.pid, port: postgres, dir: join(tmpdir(), "elsewhere", "data") })
    await expect(check(postgres, copied)).rejects.toThrow(refusal(postgres))
  })

  it("refuses when the postmaster that wrote it is gone and something else holds the port", async () => {
    const postgres = await heldPort()
    await expect(check(postgres, project({ pid: GONE, port: postgres }))).rejects.toThrow(refusal(postgres))
  })

  it("refuses when this project's Postgres runs on another port", async () => {
    const postgres = await heldPort()
    await expect(check(postgres, project({ pid: process.pid, port: postgres + 1 }))).rejects.toThrow(refusal(postgres))
  })

  it("refuses when the data directory has no running Postgres at all", async () => {
    const postgres = await heldPort()
    await expect(check(postgres, stateDir())).rejects.toThrow(refusal(postgres))
  })
})
