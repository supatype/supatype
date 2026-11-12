import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { detectProjectSetup, withFreeVitePort } from "../src/init-project-detect.js"
import { isLoopbackPortInUse, isPortInUse } from "../src/postgres-ctl.js"

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `supatype-detect-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("detectProjectSetup()", () => {
  it("returns empty summary for an empty directory", () => {
    const detected = detectProjectSetup(dir)
    expect(detected.hasExistingFiles).toBe(false)
    expect(detected.hasVite).toBe(false)
    expect(detected.summaryLines).toEqual([])
  })

  it("detects Vite config and port", () => {
    writeFileSync(
      join(dir, "vite.config.ts"),
      `export default { server: { port: 5174 } }`,
      "utf8",
    )
    const detected = detectProjectSetup(dir)
    expect(detected.hasVite).toBe(true)
    expect(detected.hasViteConfig).toBe(true)
    expect(detected.viteDevUrl).toBe("http://127.0.0.1:5174")
    expect(detected.summaryLines.some((line) => line.includes("Vite config"))).toBe(true)
  })

  it("detects static dist directory", () => {
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "index.html"), "<html></html>", "utf8")
    const detected = detectProjectSetup(dir)
    expect(detected.staticDir).toBe("./dist")
    expect(detected.summaryLines.some((line) => line.includes("./dist"))).toBe(true)
  })

  it("detects existing supatype.config.ts", () => {
    writeFileSync(join(dir, "supatype.config.ts"), "export default {}", "utf8")
    const detected = detectProjectSetup(dir)
    expect(detected.hasSupatypeConfig).toBe(true)
    expect(detected.summaryLines).toContain("supatype.config already present")
  })
})

// 0.9.1 release test (FF21): init proposed 5173 while another project's app already held it.
describe("withFreeVitePort()", () => {
  it("proposes the next free port when the detected one is taken", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^8.0.0" } }), "utf8")
    const detected = await withFreeVitePort(detectProjectSetup(dir), async (port) => port === 5173 || port === 5174)
    expect(detected.viteDevUrl).toBe("http://127.0.0.1:5175")
    expect(detected.summaryLines).toContain("Port 5173 is in use, so Vite is offered 5175")
  })

  it("keeps a free port as detected", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^8.0.0" } }), "utf8")
    const detected = await withFreeVitePort(detectProjectSetup(dir), async () => false)
    expect(detected.viteDevUrl).toBe("http://127.0.0.1:5173")
  })

  it("checks before Vite is installed too, since init can scaffold it", async () => {
    const detected = await withFreeVitePort(detectProjectSetup(dir), async (port) => port === 5173)
    expect(detected.viteDevUrl).toBe("http://127.0.0.1:5174")
  })
})

describe("isLoopbackPortInUse()", () => {
  it("sees a listener on [::1] alone, which the 127.0.0.1 check misses", async () => {
    const server = createServer()
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(0, "::1", () => resolve(true))
    })
    if (!listening) return // No IPv6 loopback on this machine: nothing to see.
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    try {
      expect(await isPortInUse(port)).toBe(false)
      expect(await isLoopbackPortInUse(port)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
