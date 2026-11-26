import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { downloadToFile } from "../src/cdn-fetch.js"
import type { ClackApi } from "../src/ui/clack-api.js"
import { setActiveFlowApi } from "../src/ui/runtime/flow-session.js"
import { portOf } from "./support/ports.js"

/** An archive's progress line is drawn in place on a bare terminal, and goes to the flow's log under a flow. */
let server: Server
let base: string
let dir: string
let written: string[]

function flowLoggingTo(logged: string[]): ClackApi {
  const unused = (): never => {
    throw new Error("not used by a download")
  }
  const say = (line: string): void => void logged.push(line)
  return {
    intro: say, outro: say, note: say, cancel: unused, text: unused, password: unused, select: unused, confirm: unused, spinner: unused,
    log: { info: say, warn: say, error: say, success: say },
  }
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "supatype-progress-"))
  written = []
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": "2000000" })
    res.end(Buffer.alloc(2_000_000, 1))
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  base = `http://127.0.0.1:${portOf(server)}`
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { written.push(String(c)); return true })
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { written.push(a.join(" ")) })
})

afterEach(async () => {
  setActiveFlowApi(null)
  Reflect.deleteProperty(process.stdout, "isTTY")
  vi.restoreAllMocks()
  await new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) })
  rmSync(dir, { recursive: true, force: true })
})

describe("an archive's progress line", () => {
  it("is drawn in place on a terminal with no flow up", async () => {
    setTty(true)
    await downloadToFile(`${base}/a`, join(dir, "a"), "supatype 9.9.9")
    const out = written.join("")
    expect(out).toContain("\r[supatype] Downloading supatype 9.9.9: ")
    expect(out).toContain("MB")
  })

  it("goes to the active flow's log, never written in place, when a flow is up", async () => {
    const logged: string[] = []
    setActiveFlowApi(flowLoggingTo(logged))
    setTty(true)
    await downloadToFile(`${base}/a`, join(dir, "a"), "supatype 9.9.9")
    expect(written.join("")).not.toContain("\r")
    expect(logged).toEqual(["Downloading supatype 9.9.9 (2.0 MB)...", "Downloaded supatype 9.9.9."])
  })
})
