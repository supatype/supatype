import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startNativeRealtime, type NativeRealtimeOptions } from "../src/native-realtime.js"
import { isJsonObject } from "@supatype/shared"
import { parseJsonAs } from "./support/json.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Native dev printed "Realtime unavailable" when it found no realtime binary, but had already told
 * the gateway realtime was enabled. The gateway then proxied subscriptions to a port nothing
 * listened on, answering a bare 502, and its /health reported realtime not ready, so every client
 * subscription failed with nothing saying why. The manifest has to say what is actually running.
 */
const URL = "http://127.0.0.1:54329"
let dir = ""

function options(): NativeRealtimeOptions {
  return {
    config: projectConfig(),
    cwd: dir,
    manifestPath: join(dir, "routes.json"),
    pidDir: dir,
    url: URL,
    port: "54329",
    databaseUrl: "postgres://localhost/none",
    jwtSecret: "secret",
  }
}

const manifest = (): Record<string, unknown> => parseJsonAs(readFileSync(join(dir, "routes.json"), "utf8"), isJsonObject)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-native-realtime-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("startNativeRealtime", () => {
  it("disables realtime in the route manifest when no realtime binary can be found", async () => {
    // A manifest from a previous run in which realtime did start.
    writeFileSync(join(dir, "routes.json"), JSON.stringify({ rest_enabled: true, realtime_enabled: true, realtime_url: URL }))
    const missing = async (): Promise<never> => {
      throw new Error("realtime binary not available")
    }

    expect(await startNativeRealtime(options(), missing)).toBeNull()
    expect(manifest()).toEqual({ rest_enabled: true, realtime_enabled: false })
  })

  it("enables realtime, at its URL, when it starts", async () => {
    const idle = { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }
    const proc = await startNativeRealtime(options(), async () => idle)
    try {
      expect(proc).not.toBeNull()
      expect(manifest()).toEqual({ realtime_enabled: true, realtime_url: URL })
    } finally {
      await proc?.stop()
    }
  })
})
