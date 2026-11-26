import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { extractArchive, systemTar, unpackCommand } from "../src/archive-extract.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("unpacking a release archive", () => {
  it("unpacks a zip with Windows' own tar.exe, by its full path", () => {
    const { command, args } = unpackCommand("C:\cache\a.zip", "C:\cache\a", () => true)
    expect(command).toBe(systemTar())
    expect(args).toEqual(["-xf", "C:\cache\a.zip", "-C", "C:\cache\a"])
  })

  it("falls back to Expand-Archive, stopping on its first error, when Windows has no tar.exe", () => {
    const { command, args } = unpackCommand("C:\cache\a.zip", "C:\cache\a", () => false)
    expect(command).toBe("powershell.exe")
    expect(args.at(-1)).toMatch(/^\$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath /)
  })

  it("unpacks a tar.gz with the tar on PATH", () => {
    expect(unpackCommand("/c/a.tar.gz", "/c/a")).toEqual({ command: "tar", args: ["-xzf", "/c/a.tar.gz", "-C", "/c/a"] })
  })

  it("names the archive and the reason when the unpack fails", () => {
    const spawn = () => ({ status: 1, stderr: Buffer.from("not a zip") })
    const dir = mkdtempSync(join(tmpdir(), "supatype-extract-"))
    dirs.push(dir)
    expect(() => extractArchive(join(dir, "x.tar.gz"), join(dir, "out"), spawn)).toThrow(/x\.tar\.gz: not a zip/)
  })

  it.runIf(process.platform === "win32")("really unpacks a zip on Windows, putting the executable at the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-extract-"))
    dirs.push(dir)
    const stage = join(dir, "stage")
    mkdirSync(stage)
    writeFileSync(join(stage, "supatype.exe"), "exe")
    const zip = join(dir, "release.zip")
    expect(spawnSync(systemTar(), ["-a", "-c", "-f", zip, "-C", stage, "supatype.exe"]).status).toBe(0)
    extractArchive(zip, join(dir, "out"))
    expect(existsSync(join(dir, "out", "supatype.exe"))).toBe(true)
    expect(readFileSync(join(dir, "out", "supatype.exe"), "utf8")).toBe("exe")
  })
})
