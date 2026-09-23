import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let counter = 0
let tmpDir: string

// The published artefacts: one archive per platform, plus the musl variants Homebrew does not
// use, since Homebrew on Linux is glibc.
const ARCHIVES = [
  "supatype-cli-darwin-arm64.tar.gz",
  "supatype-cli-darwin-amd64.tar.gz",
  "supatype-cli-linux-arm64.tar.gz",
  "supatype-cli-linux-amd64.tar.gz",
  "supatype-cli-linux-amd64-musl.tar.gz",
  "supatype-cli-windows-amd64.zip",
]

const script = () => join(import.meta.dirname, "../scripts/generate-homebrew-formula.mjs")

/** Write stub archives and the checksums manifest that build-release-artifacts.sh produces. */
function writeArtifacts(names: string[]): Record<string, string> {
  const hashes: Record<string, string> = {}
  const lines: string[] = []
  for (const name of names) {
    const body = `stub-${name}\n`
    writeFileSync(join(tmpDir, name), body, "utf8")
    hashes[name] = createHash("sha256").update(body).digest("hex")
    lines.push(`${hashes[name]}  ${name}`)
  }
  writeFileSync(join(tmpDir, "checksums.sha256"), lines.join("\n") + "\n", "utf8")
  return hashes
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `homebrew-formula-${Date.now()}-${++counter}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("generate-homebrew-formula.mjs", () => {
  it("points at the published archives, with the hashes from the manifest", () => {
    const hashes = writeArtifacts(ARCHIVES)
    const outPath = join(tmpDir, "supatype.rb")
    const result = spawnSync(process.execPath, [script(), "9.9.9", tmpDir], {
      encoding: "utf8",
      env: { ...process.env, HOMEBREW_FORMULA_OUT: outPath },
    })

    expect(result.status, result.stderr).toBe(0)
    const formula = readFileSync(outPath, "utf8")

    expect(formula).toContain('version "9.9.9"')
    expect(formula).toContain('license "Apache-2.0"')
    expect(formula).toContain(
      "https://releases.supatype.com/cli/v9.9.9/supatype-cli-darwin-arm64.tar.gz",
    )
    // The hash has to be the manifest's, not one the generator computed for itself: the manifest
    // is the signed record of what was published.
    expect(formula).toContain(`sha256 "${hashes["supatype-cli-darwin-arm64.tar.gz"]}"`)
    // Every archive holds one executable called `supatype`, so there is no per-platform rename.
    expect(formula).toContain('bin.install "supatype"')
    expect(formula).toContain('system bin/"supatype", "_postinstall"')
  })

  it("does not reference the musl or windows artefacts", () => {
    writeArtifacts(ARCHIVES)
    const outPath = join(tmpDir, "supatype.rb")
    const result = spawnSync(process.execPath, [script(), "9.9.9", tmpDir], {
      encoding: "utf8",
      env: { ...process.env, HOMEBREW_FORMULA_OUT: outPath },
    })

    expect(result.status, result.stderr).toBe(0)
    const formula = readFileSync(outPath, "utf8")
    expect(formula).not.toContain("musl")
    expect(formula).not.toContain("windows")
  })

  it("fails when the manifest is missing, rather than hashing the files itself", () => {
    writeArtifacts(ARCHIVES)
    rmSync(join(tmpDir, "checksums.sha256"))
    const result = spawnSync(process.execPath, [script(), "1.0.0", tmpDir], { encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("checksums.sha256")
  })

  it("fails when the manifest omits a platform it needs", () => {
    writeArtifacts(ARCHIVES.filter((n) => n !== "supatype-cli-linux-amd64.tar.gz"))
    const result = spawnSync(process.execPath, [script(), "1.0.0", tmpDir], { encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("No checksum for supatype-cli-linux-amd64.tar.gz")
  })
})
