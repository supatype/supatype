import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NativePortClaim } from "../src/commands/dev.js"
import { portLockPath } from "../src/native-port-lock.js"
import { freePort } from "./support/ports.js"

/** N-FF12 and R2-RB1: why PostgREST's port is claimed, and why with a file, are in native-port-lock.ts. */

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { claimNativeDevPorts } = await import("../src/commands/dev.js")

const roots: string[] = []
const claims: NativePortClaim[] = []
afterEach(() => {
  for (const claim of claims.splice(0)) claim.postgrest.release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A project's native ports, every one free now, and its state directory with no Postgres running. */
async function project(postgrest?: number): Promise<Parameters<typeof claimNativeDevPorts>> {
  const root = mkdtempSync(join(tmpdir(), "supatype-postgrest-port-"))
  roots.push(root)
  const ports = { postgres: await freePort(), server: await freePort(), postgrest: postgrest ?? (await freePort()), realtime: await freePort() }
  return [ports, { dataDir: join(root, "data"), pidDir: join(root, "pid") }]
}

/** The first project's check, its claim kept until the test ends. */
async function claim(...args: Parameters<typeof claimNativeDevPorts>): Promise<NativePortClaim> {
  const held = await claimNativeDevPorts(...args)
  claims.push(held)
  return held
}

describe("PostgREST's port while another native project starts", () => {
  it("is refused to a second project whose check comes before the first project's PostgREST binds", async () => {
    const first = await project()
    await claim(...first)
    const port = first[0].postgrest
    await expect(claimNativeDevPorts(...(await project(port)))).rejects.toThrow(
      new RegExp(`Port ${port} is claimed by another native dev \\(pid ${process.pid}\\)[\\s\\S]*${port}\\.lock[\\s\\S]*server\\.postgrestPort`),
    )
  })

  it("is the next project's once the claim lets it go", async () => {
    const first = await project()
    const held = await claim(...first)
    const port = first[0].postgrest
    held.postgrest.release()
    expect(existsSync(portLockPath(port))).toBe(false)
    await expect(claim(...(await project(port)))).resolves.toBeDefined()
  })
})

/** True when this process can listen on 127.0.0.1:`port`, so nothing of the claim's sits on it. */
async function listenSucceeds(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

/** The id of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""])
  if (child.pid === undefined) throw new Error("could not start a process to take a dead pid from")
  return child.pid
}

describe("PostgREST's port claim", () => {
  it("opens nothing on the port, so no process the start launches can be given it", async () => {
    const first = await project()
    await claim(...first)
    expect(await listenSucceeds(first[0].postgrest)).toBe(true)
  })

  it("is not refused by a claim whose dev is gone", async () => {
    const first = await project()
    const port = first[0].postgrest
    mkdirSync(dirname(portLockPath(port)), { recursive: true })
    writeFileSync(portLockPath(port), `${deadPid()}\n`)
    await expect(claim(...first)).resolves.toBeDefined()
  })
})
