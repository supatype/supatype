import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let counter = 0
let tmpDir: string

const PLATFORMS = [
  "supatype-cli-darwin-arm64",
  "supatype-cli-darwin-amd64",
  "supatype-cli-linux-arm64",
  "supatype-cli-linux-amd64",
]

beforeEach(() => {
  tmpDir = join(tmpdir(), `homebrew-formula-${Date.now()}-${++counter}`)
  mkdirSync(tmpDir, { recursive: true })
  for (const name of PLATFORMS) {
    writeFileSync(join(tmpDir, name), `stub-${name}\n`, "utf8")
  }
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("generate-homebrew-formula.mjs", () => {
  it("writes a Formula with versioned CDN URLs and sha256 blocks", () => {
    const outPath = join(tmpDir, "supatype.rb")
    const script = join(import.meta.dirname, "../scripts/generate-homebrew-formula.mjs")
    const result = spawnSync(
      process.execPath,
      [script, "9.9.9", tmpDir],
      {
        encoding: "utf8",
        env: { ...process.env, HOMEBREW_FORMULA_OUT: outPath },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    const formula = readFileSync(outPath, "utf8")
    expect(formula).toContain('version "9.9.9"')
    expect(formula).toContain("https://releases.supatype.com/cli/v9.9.9/supatype-cli-darwin-arm64")
    expect(formula).toMatch(/sha256 "[a-f0-9]{64}"/)
    expect(formula).toContain('system bin/"supatype", "_postinstall"')
    expect(formula).toContain('bin.install "supatype-cli-#{arch}" => "supatype"')
  })

  it("fails when an artifact is missing", () => {
    rmSync(join(tmpDir, "supatype-cli-linux-amd64"))
    const script = join(import.meta.dirname, "../scripts/generate-homebrew-formula.mjs")
    const result = spawnSync(process.execPath, [script, "1.0.0", tmpDir], { encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Missing artifact")
  })
})
