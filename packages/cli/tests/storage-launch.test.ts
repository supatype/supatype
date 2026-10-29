import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { archiveNameCandidates, validateArtifactFormat } from "../src/binary-cache.js"
import { storageExecutableName, unpackedStorage } from "../src/storage-launch.js"

/**
 * The storage service ships as an archive per platform (the executable, and sharp's prebuilt libvips
 * beside it, which no single executable can hold), so the CLI unpacks what it downloaded before it
 * can run it, as it does for Postgres.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An archive like a release's, holding `files` (name to contents), at `<dir>/<name>`. */
function archive(name: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-storage-archive-"))
  dirs.push(dir)
  const stage = join(dir, "stage")
  mkdirSync(stage)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(stage, file), text)
  const out = join(dir, name)
  const result = out.endsWith(".zip")
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${out}'`])
    : spawnSync("tar", ["-czf", out, "-C", stage, "."])
  if (result.status !== 0) throw new Error(`could not build ${out}: ${result.stderr}`)
  return out
}

const EXT = process.platform === "win32" ? "zip" : "tar.gz"

describe("the storage release archive", () => {
  it("is named per platform, a zip for Windows and a tar.gz elsewhere", () => {
    expect(archiveNameCandidates("storage", "0.7.0", { os: "windows", arch: "amd64" })).toEqual(["supatype-storage-windows-amd64.zip"])
    expect(archiveNameCandidates("storage", "0.7.0", { os: "linux", arch: "arm64" })).toEqual(["supatype-storage-linux-arm64.tar.gz"])
  })

  it("is refused when the download is not an archive", () => {
    const page = join(mkdtempSync(join(tmpdir(), "supatype-storage-html-")), `supatype-storage.${EXT}`)
    dirs.push(join(page, ".."))
    writeFileSync(page, "<html>not found</html>".padEnd(128, " "))
    const platform = process.platform === "win32" ? { os: "windows", arch: "amd64" } as const : { os: "linux", arch: "amd64" } as const
    expect(() => validateArtifactFormat("storage", page, platform)).toThrow(/storage file is not a (zip|gzip) archive/)
  })

  it("is unpacked once, beside where it is cached, and its executable run from there", () => {
    const path = archive(`supatype-storage-test.${EXT}`, { [storageExecutableName()]: "exe" })
    const exe = unpackedStorage(path)
    expect(exe).toBe(join(path.replace(`.${EXT}`, ""), storageExecutableName()))
    // Unpacked already, so the archive is not read again: gone, it is not missed.
    rmSync(path)
    expect(unpackedStorage(path)).toBe(exe)
  }, 60_000)

  it("is refused, by name, when it holds no executable", () => {
    const path = archive(`supatype-storage-empty.${EXT}`, { "README.txt": "nothing to run" })
    expect(() => unpackedStorage(path)).toThrow(/holds no supatype-storage/)
    expect(existsSync(path)).toBe(true)
  }, 60_000)
})
