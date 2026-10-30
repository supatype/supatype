import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startNativeRealtime, type NativeRealtimeOptions } from "../src/native-realtime.js"
import type { RealtimeLaunchSpec } from "../src/realtime-launch.js"
import type { ProcessManager } from "../src/process-manager.js"
import { isJsonObject } from "@supatype/shared"
import { parseJsonAs } from "./support/json.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Native dev printed "Realtime unavailable" when it found no realtime binary, but had already told
 * the gateway realtime was enabled. The gateway then proxied subscriptions to a port nothing
 * listened on, answering a bare 502, and its /health reported realtime not ready, so every client
 * subscription failed with nothing saying why. The manifest has to say what is actually running.
 *
 * Local test N3: it also printed "Realtime service: <url>" and enabled realtime for a process that
 * had exited at once (the released Windows binary, on a Postgres without logical decoding) or that
 * had disabled itself ("[realtime] disabled: wal_level is not logical"). What is announced has to be
 * what answers.
 */
let dir = ""
let port = 0
let logs: string[] = []
let warnings: string[] = []
const started: ProcessManager[] = []

function options(): NativeRealtimeOptions {
  return {
    config: projectConfig(),
    cwd: dir,
    manifestPath: join(dir, "routes.json"),
    pidDir: dir,
    url: `http://127.0.0.1:${port}`,
    port: String(port),
    databaseUrl: "postgres://localhost/none",
    jwtSecret: "secret",
    readyTimeoutMs: 3_000,
  }
}

const manifest = (): Record<string, unknown> => parseJsonAs(readFileSync(join(dir, "routes.json"), "utf8"), isJsonObject)

/** A port nothing listens on yet. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
    })
  })
}

/** A stand-in realtime: `body` is the script node runs, with PORT in its environment. */
function fakeRealtime(body: string): () => Promise<RealtimeLaunchSpec> {
  const script = join(dir, "fake-realtime.cjs")
  writeFileSync(script, body, "utf8")
  return async () => ({ bin: process.execPath, args: [script] })
}

/** A realtime answering /health/ready with `status` and `json`, exiting after `lifeMs` when given. */
function answering(status: number, json: object, lifeMs?: number): () => Promise<RealtimeLaunchSpec> {
  return fakeRealtime(`
const http = require("node:http")
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/health/ready" ? ${status} : 200, { "Content-Type": "application/json" })
  res.end(${JSON.stringify(JSON.stringify(json))})
})
server.listen(Number(process.env.PORT), "127.0.0.1")
${lifeMs === undefined ? "" : `setTimeout(() => process.exit(0), ${lifeMs})`}
`)
}

async function start(launch: () => Promise<RealtimeLaunchSpec>): Promise<ProcessManager | null> {
  const proc = await startNativeRealtime(options(), launch)
  if (proc !== null) started.push(proc)
  return proc
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-realtime-"))
  port = await freePort()
  logs = []
  warnings = []
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")))
})

afterEach(async () => {
  await Promise.all(started.splice(0).map((proc) => proc.stop()))
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("startNativeRealtime", () => {
  it("disables realtime in the route manifest when no realtime binary can be found", async () => {
    // A manifest from a previous run in which realtime did start.
    writeFileSync(join(dir, "routes.json"), JSON.stringify({ rest_enabled: true, realtime_enabled: true, realtime_url: "x" }))
    const missing = async (): Promise<never> => {
      throw new Error("realtime binary not available")
    }

    expect(await startNativeRealtime(options(), missing)).toBeNull()
    expect(manifest()).toEqual({ rest_enabled: true, realtime_enabled: false })
  })

  it("enables realtime, at its URL, once it answers ready", async () => {
    expect(await start(answering(200, { status: "ok" }))).not.toBeNull()
    expect(manifest()).toEqual({ realtime_enabled: true, realtime_url: options().url })
    expect(logs.join("\n")).toContain(`Realtime service: ${options().url}`)
  })

  it("disables realtime and says so when the process exits without answering", async () => {
    expect(await start(fakeRealtime("process.exit(0)\n"))).toBeNull()
    expect(manifest()).toEqual({ realtime_enabled: false })
    expect(logs.join("\n")).not.toContain("Realtime service:")
    expect(warnings.join("\n")).toMatch(/Realtime is not running: it exited/)
  })

  it("disables realtime when nothing ever answers at its port", async () => {
    expect(await start(fakeRealtime("setInterval(() => {}, 1000)\n"))).toBeNull()
    expect(manifest()).toEqual({ realtime_enabled: false })
    expect(warnings.join("\n")).toMatch(/Realtime is not running: nothing answered/)
  }, 10_000)

  it("says database changes are off when realtime disabled them, rather than that it is running", async () => {
    await start(answering(503, { status: "unsupported", reason: "wal_level is not logical" }))
    expect(logs.join("\n")).not.toContain("Realtime service:")
    expect(warnings.join("\n")).toMatch(/database changes are off: wal_level is not logical/)
  })

  // Connecting is up: the socket answers, and waiting out the whole limit for the database held dev's
  // start for 15 seconds. Realtime is announced at once, and a later exit is still heard.
  it("announces a realtime still connecting at once, and still hears it exit", async () => {
    const begun = Date.now()
    expect(await start(answering(503, { status: "connecting" }, 1_000))).not.toBeNull()
    expect(Date.now() - begun).toBeLessThan(options().readyTimeoutMs ?? 0)
    expect(logs.join("\n")).toContain(`Realtime service: ${options().url} (still connecting to the database)`)
    await vi.waitFor(() => expect(manifest()).toEqual({ realtime_enabled: false }), { timeout: 5_000 })
  }, 10_000)

  it("disables realtime when it exits after starting", async () => {
    await start(answering(200, { status: "ok" }, 500))
    expect(manifest()["realtime_enabled"]).toBe(true)
    await vi.waitFor(() => expect(manifest()).toEqual({ realtime_enabled: false }), { timeout: 5_000 })
    expect(warnings.join("\n")).toMatch(/Realtime exited/)
  }, 10_000)
})
