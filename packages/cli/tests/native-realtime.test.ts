import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startNativeRealtime, type NativeRealtimeOptions } from "../src/native-realtime.js"
import { decodingProblem } from "../src/db-preflight.js"
import type { ComponentLaunchSpec } from "../src/component-launch.js"
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
function fakeRealtime(body: string): () => Promise<ComponentLaunchSpec> {
  const script = join(dir, "fake-realtime.cjs")
  writeFileSync(script, body, "utf8")
  return async () => ({ bin: process.execPath, args: [script] })
}

/** A realtime answering /health/ready with `status` and `json`, exiting after `lifeMs` when given. */
function answering(status: number, json: object, lifeMs?: number): () => Promise<ComponentLaunchSpec> {
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

async function start(launch: () => Promise<ComponentLaunchSpec>): Promise<ProcessManager | null> {
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
    expect(manifest()).toEqual({ rest_enabled: true, services: { realtime: { enabled: false } } })
  })

  it("enables realtime, at its URL, once it answers ready", async () => {
    expect(await start(answering(200, { status: "ok" }))).not.toBeNull()
    expect(manifest()).toEqual({ services: { realtime: { enabled: true } }, realtime_url: options().url })
    expect(logs.join("\n")).toContain(`Realtime service: ${options().url}`)
  })

  // Local test round 3c (N18): native realtime listened on every address, 0.0.0.0 and [::].
  it("tells realtime to listen on 127.0.0.1 only", async () => {
    const seen = JSON.stringify(join(dir, "realtime-host"))
    const proc = await start(fakeRealtime(`
require("node:fs").writeFileSync(${seen}, process.env.REALTIME_HOST ?? "unset")
require("node:http").createServer((req, res) => res.end("{}")).listen(Number(process.env.PORT), "127.0.0.1")
`))
    expect(proc).not.toBeNull()
    expect(readFileSync(join(dir, "realtime-host"), "utf8")).toBe("127.0.0.1")
  })

  it("disables realtime and says so when the process exits without answering", async () => {
    expect(await start(fakeRealtime("process.exit(0)\n"))).toBeNull()
    expect(manifest()).toEqual({ services: { realtime: { enabled: false } } })
    expect(logs.join("\n")).not.toContain("Realtime service:")
    expect(warnings.join("\n")).toMatch(/Realtime is not running: it exited/)
  })

  // 0.9.2 release test N-FF2: one that has not answered by the deadline is off at the gateway, and
  // still running: it was stopped there, which took it from the crash-loop supervisor.
  it("switches realtime off at the gateway, and says so, while nothing answers at its port", async () => {
    const proc = await start(fakeRealtime("setInterval(() => {}, 1000)\n"))
    expect(proc).not.toBeNull()
    expect(manifest()).toEqual({ services: { realtime: { enabled: false } } })
    expect(warnings.join("\n")).toMatch(
      /Realtime is not answering yet: nothing answered at .* within 3s\. It is switched off at the gateway until it answers/,
    )
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(proc?.stopRequested).toBe(false)
    expect(manifest()).toEqual({ services: { realtime: { enabled: false } } })
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
    await vi.waitFor(() => expect(manifest()).toEqual({ services: { realtime: { enabled: false } } }), { timeout: 5_000 })
  }, 10_000)

  // Local test round 7 (3b-22): on a Postgres without wal2json, realtime answers "connecting" first
  // and "unsupported" once it has asked the database. Dev printed only the connecting line, and the
  // "database changes are off" line round 6 showed never came.
  it("says database changes are off when a realtime announced as connecting finds it cannot stream them", async () => {
    const launch = fakeRealtime(`
const http = require("node:http")
const begun = Date.now()
http.createServer((req, res) => {
  const settled = Date.now() - begun > 1000
  res.writeHead(503, { "Content-Type": "application/json" })
  res.end(JSON.stringify(settled ? { status: "unsupported", reason: "wal2json is not installed" } : { status: "connecting" }))
}).listen(Number(process.env.PORT), "127.0.0.1")
`)
    expect(await start(launch)).not.toBeNull()
    expect(logs.join("\n")).toContain("(still connecting to the database)")
    await vi.waitFor(() => expect(warnings.join("\n")).toMatch(/Realtime is up at .* but database changes are off: wal2json is not installed/), { timeout: 6_000 })
  }, 10_000)

  // 0.9.2 release test N-FF2: a realtime that had not answered by the deadline was stopped, so the
  // crash-loop supervisor never got to retry it, and its pane ended on "restarting in 8000ms" for
  // good. It is now off at the gateway and left with the supervisor, and back on once it answers.
  describe("not answering by the deadline", () => {
    let pane: string[] = []
    beforeEach(() => {
      pane = []
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        pane.push(String(chunk))
        return true
      })
    })
    const decodes = async (): Promise<string | undefined> => undefined
    /** Short waits, so a crash loop runs its course within a test. */
    const quick = (supervision: NonNullable<NativeRealtimeOptions["supervision"]>): NativeRealtimeOptions => ({
      ...options(),
      readyTimeoutMs: 300,
      supervision,
    })
    const launched = async (opts: NativeRealtimeOptions, launch: () => Promise<ComponentLaunchSpec>) => {
      const proc = await startNativeRealtime(opts, launch, decodes)
      if (proc !== null) started.push(proc)
      return proc
    }

    it("keeps a crash-looping realtime supervised, and switches it back on once it answers", async () => {
      // Exits 1 at once on its first six runs, past the fifth that slows its restarts, then answers.
      const runs = JSON.stringify(join(dir, "runs"))
      const launch = fakeRealtime(`
const fs = require("node:fs")
const run = (fs.existsSync(${runs}) ? Number(fs.readFileSync(${runs}, "utf8")) : 0) + 1
fs.writeFileSync(${runs}, String(run))
if (run <= 6) process.exit(1)
require("node:http").createServer((req, res) => res.end("{}")).listen(Number(process.env.PORT), "127.0.0.1")
`)
      const proc = await launched(quick({ initialBackoffMs: 20, maxBackoffMs: 50, giveUpWaitMs: 60_000 }), launch)
      expect(proc).not.toBeNull()
      expect(manifest()).toEqual({ services: { realtime: { enabled: false } } })
      expect(warnings.join("\n")).toMatch(/Realtime is not answering yet: it exited with an error \d+ times? as it started/)
      await vi.waitFor(() => expect(manifest()).toEqual({ services: { realtime: { enabled: true } }, realtime_url: options().url }), { timeout: 8_000 })
      expect(logs.filter((line) => line.includes("switched back on at the gateway"))).toEqual([
        `[supatype] Realtime answers at ${options().url} now, so it is switched back on at the gateway.`,
      ])
      expect(pane.join("")).toMatch(/so it is retried less often/)
    }, 15_000)

    it("still says in its pane when the supervisor gives up on it", async () => {
      const proc = await launched(quick({ initialBackoffMs: 20, maxBackoffMs: 50, giveUpWaitMs: 400 }), fakeRealtime("process.exit(1)\n"))
      expect(proc).not.toBeNull()
      // Switched off at the deadline, before the supervisor gave up: the path the stop line was lost on.
      expect(warnings.join("\n")).toMatch(/Realtime is not answering yet/)
      await vi.waitFor(() => expect(pane.join("")).toMatch(/\[realtime\].* still crashing as it starts, not restarting it\./), { timeout: 8_000 })
      expect(manifest()).toEqual({ services: { realtime: { enabled: false } } })
    }, 15_000)
  })

  it("disables realtime when it exits after starting", async () => {
    await start(answering(200, { status: "ok" }, 500))
    expect(manifest()["services"]).toEqual({ realtime: { enabled: true } })
    await vi.waitFor(() => expect(manifest()).toEqual({ services: { realtime: { enabled: false } } }), { timeout: 5_000 })
    expect(warnings.join("\n")).toMatch(/Realtime exited/)
  }, 10_000)
})

/**
 * Local test round 3: realtime's silent exit was explained as "on a Postgres without logical
 * decoding" while `wal_level` was logical; the real cause was no wal2json. Dev now asks the database
 * the way `db check` does and names what it found.
 */
describe("a realtime that exits without a word", () => {
  it("names the decoding check's own finding", async () => {
    const check = async (): Promise<string | undefined> => "the wal2json output plugin is not installed on this server"
    expect(await startNativeRealtime(options(), fakeRealtime("process.exit(0)\n"), check)).toBeNull()
    const said = warnings.join("\n")
    expect(said).toContain("the wal2json output plugin is not installed on this server")
    expect(said).not.toContain("without logical decoding")
  })

  it("does not blame decoding when the database can decode", async () => {
    const check = async (): Promise<string | undefined> => undefined
    expect(await startNativeRealtime(options(), fakeRealtime("process.exit(0)\n"), check)).toBeNull()
    expect(warnings.join("\n")).toContain("logical decoding works on this Postgres")
  })
})

describe("decodingProblem", () => {
  /** A database answering `SHOW wal_level` with `level`, and the slot probe with `slotError`. */
  function database(level: string, slotError?: { code: string }): (sql: string) => Promise<Record<string, unknown>[]> {
    return async (sql) => {
      if (sql.startsWith("SHOW wal_level")) return [{ wal_level: level }]
      if (sql.includes("max_replication_slots")) return [{ used: "0", max: "10", existing: "", role: "postgres" }]
      if (sql.includes("pg_create_logical_replication_slot") && slotError !== undefined) {
        throw Object.assign(new Error("could not access file"), slotError)
      }
      return [{}]
    }
  }

  it("names wal_level when it is not logical", async () => {
    expect(await decodingProblem(database("replica"))).toBe('wal_level is "replica", not logical')
  })

  it("names a missing wal2json when wal_level is logical", async () => {
    expect(await decodingProblem(database("logical", { code: "58P01" }))).toBe(
      "the wal2json output plugin is not installed on this server",
    )
  })

  it("finds nothing when a wal2json slot can be made", async () => {
    expect(await decodingProblem(database("logical"))).toBeUndefined()
  })
})
