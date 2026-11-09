import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn() })),
}))

import { startProxyDevApp } from "../src/app/proxy-dev-app.js"
import { beginDevSession, endDevSession, type DevSession } from "../src/dev-session.js"
import { LineBuffer, type ProcessManager } from "../src/process-manager.js"
import { projectConfig } from "./support/project-config.js"

/**
 * The proxy app's output reached the app pane cut up and incomplete: a line split across two
 * reads arrived as two lines, a CRLF line kept its carriage return, and an app that crashed on
 * every start showed its error once, because each restart's identical error was dropped as a
 * duplicate of the one before. A failing app gave nothing to go on after the first crash.
 */
const FAKE_APP = String.raw`
process.stdout.write("\x1b[32m  VITE v6.0.0\x1b[39m  ready in 120 ms\r\n")
process.stdout.write("  Local:   http://localhost:5173/\n")
process.stderr.write("request failed: /missing\n")
process.stderr.write("request failed: /missing\n")
process.stdout.write("partial ")
setTimeout(() => {
  process.stdout.write("line joined\n")
  process.stdout.write("no newline at exit")
}, 300)
`

const CRASHING_APP = String.raw`
process.stderr.write("boom: cannot find module\n")
process.exit(3)
`

let dir = ""
let manager: ProcessManager | null = null

afterEach(async () => {
  await manager?.stop()
  manager = null
  endDevSession()
  vi.restoreAllMocks()
  // Retried: on Windows the app's directory stays locked for a moment after its process tree dies.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** Starts `source` as a proxy-mode project's `start` script, in a fresh project directory. */
function startApp(source: string): void {
  dir = mkdtempSync(join(tmpdir(), "supatype-proxy-out-"))
  writeFileSync(join(dir, "fake-app.cjs"), source)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", scripts: { start: "node fake-app.cjs" } }))
  const config = projectConfig({ project: { name: "fake" }, app: { mode: "proxy", start: "start" } })
  manager = startProxyDevApp(dir, config, join(dir, ".pids"))
}

function appPane(session: DevSession): () => string[] {
  return () => session.bus.getTask("app")?.lines ?? []
}

const UNTIL = { timeout: 10_000, interval: 50 }

describe("startProxyDevApp() output in the dashboard", () => {
  it("sends whole lines from the app's stdout and stderr to the app pane", async () => {
    const lines = appPane(beginDevSession("tui"))
    startApp(FAKE_APP)
    await vi.waitUntil(() => lines().some((l) => l.includes("no newline at exit")), UNTIL)
    // The two streams are read independently, so only the order within each one is fixed.
    const app = lines().slice(1)
    expect(app.filter((l) => !l.startsWith("✗ "))).toEqual([
      "\x1b[32m  VITE v6.0.0\x1b[39m  ready in 120 ms",
      "  Local:   http://localhost:5173/",
      "partial line joined",
      "no newline at exit",
    ])
    expect(app.filter((l) => l.startsWith("✗ "))).toEqual([
      "✗ request failed: /missing",
      "✗ request failed: /missing",
    ])
  }, 20_000)

  it("shows a crashing app's error on every restart, not only the first", async () => {
    const lines = appPane(beginDevSession("tui"))
    startApp(CRASHING_APP)
    await vi.waitUntil(() => lines().filter((l) => l.includes("restarting in")).length >= 2, UNTIL)
    // Stopped here so no further restart lands between the wait and the count.
    await manager?.stop()
    const errors = lines().filter((l) => l === "✗ boom: cannot find module")
    expect(errors.length).toBeGreaterThanOrEqual(2)
  }, 20_000)
})

describe("startProxyDevApp() output without the dashboard", () => {
  it("writes each app line to the terminal once, whole", async () => {
    beginDevSession("stream")
    const written: string[] = []
    const capture = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stdout, "write").mockImplementation(capture)
    vi.spyOn(process.stderr, "write").mockImplementation(capture)
    startApp(FAKE_APP)
    await vi.waitUntil(() => written.some((w) => w.includes("no newline at exit")), UNTIL)
    const appLines = written.join("").split("\n").filter((l) => l.includes("[app]"))
    expect(appLines.filter((l) => l.endsWith("partial line joined"))).toHaveLength(1)
    expect(appLines.filter((l) => l.endsWith("request failed: /missing"))).toHaveLength(2)
    expect(appLines.filter((l) => l.includes("\r"))).toEqual([])
  }, 20_000)
})

describe("LineBuffer", () => {
  it("joins a line split across reads and keeps a redrawn line's last state", () => {
    const lines: string[] = []
    const buffer = new LineBuffer((line) => lines.push(line))
    buffer.push("transforming 1/3\rtransform")
    buffer.push("ing 3/3\r\nbuilt in 2s\r\ntail")
    expect(lines).toEqual(["transforming 3/3", "built in 2s"])
    buffer.flush()
    buffer.flush()
    expect(lines).toEqual(["transforming 3/3", "built in 2s", "tail"])
  })
})

describe("LineBuffer with a long redraw", () => {
  it("holds only the latest state of a line redrawn without a newline", () => {
    const lines: string[] = []
    const buffer = new LineBuffer((line) => lines.push(line))
    for (let i = 0; i < 1_000; i++) buffer.push(`progress ${i}\r`)
    buffer.push("\ndone\r")
    buffer.push("\n")
    expect(lines).toEqual(["progress 999", "done"])
    expect(JSON.stringify(buffer).length).toBeLessThan(200)
  })
})
