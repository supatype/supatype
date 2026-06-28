import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { detectProjectSetup } from "../src/init-project-detect.js"

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
