import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureCliProgram, runCliProgram } from "../src/cli-launcher.js"
import { cliCachePath, publishedTarget } from "../src/cli-program-path.js"

const LINUX = { os: "linux", arch: "amd64" } as const

/** The npm starter: which program it runs, where it keeps it, and what it hands back. */

describe("publishedTarget", () => {
  it.each([
    ["linux", "x64", { os: "linux", arch: "amd64" }],
    ["linux", "arm64", { os: "linux", arch: "arm64" }],
    ["darwin", "x64", { os: "darwin", arch: "amd64" }],
    ["darwin", "arm64", { os: "darwin", arch: "arm64" }],
    ["win32", "x64", { os: "windows", arch: "amd64" }],
  ])("maps %s-%s to a published build", (platform, arch, target) => {
    expect(publishedTarget(platform, arch)).toEqual(target)
  })

  // currentPlatform() reads anything that is not macOS or Windows as Linux, so FreeBSD would
  // download a Linux build and fail to start it with an error that names neither.
  it.each([["win32", "arm64"], ["freebsd", "x64"], ["linux", "ia32"]])("refuses %s-%s, naming what is published", (platform, arch) => {
    expect(() => publishedTarget(platform, arch)).toThrow(`not built for ${platform}-${arch}`)
    expect(() => publishedTarget(platform, arch)).toThrow("win32-x64")
  })
})

describe("ensureCliProgram", () => {
  let home = ""

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "supatype-launcher-"))
    vi.stubEnv("HOME", home)
    vi.stubEnv("USERPROFILE", home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it("runs a cached program without going to the network", async () => {
    const cached = cliCachePath("9.9.9", LINUX)
    mkdirSync(join(cached, ".."), { recursive: true })
    writeFileSync(cached, "")
    const fetch = vi.fn(() => Promise.reject(new Error("offline")))
    vi.stubGlobal("fetch", fetch)
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    await expect(ensureCliProgram("9.9.9", LINUX)).resolves.toBe(cached)
    expect(fetch).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
  })

  it("names the version and the mirror setting when the download fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))))
    vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const failure = ensureCliProgram("9.9.9", LINUX)
    await expect(failure).rejects.toThrow("Could not download the Supatype CLI v9.9.9: getaddrinfo ENOTFOUND")
    await expect(failure).rejects.toThrow("SUPATYPE_CDN_BASE")
  })
})

describe("runCliProgram", () => {
  it("returns the program's exit code", async () => {
    await expect(runCliProgram(process.execPath, ["-e", "process.exit(7)"])).resolves.toBe(7)
  })

  it("passes the arguments through unchanged", async () => {
    const code = "process.exit(process.argv.slice(1).join('|') === 'a b|--c=d' ? 0 : 1)"
    await expect(runCliProgram(process.execPath, ["-e", code, "a b", "--c=d"])).resolves.toBe(0)
  })

  it.skipIf(process.platform === "win32")("reports a program ended by a signal as 128 plus its number", async () => {
    await expect(runCliProgram(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"])).resolves.toBe(143)
  })

  // On Windows the console delivers Ctrl+C to the program itself, and a kill there would end it
  // at once, skipping its shutdown.
  it.skipIf(process.platform !== "win32")("leaves a Ctrl+C to the program on Windows", async () => {
    const running = runCliProgram(process.execPath, ["-e", "setTimeout(() => process.exit(0), 600)"])
    setTimeout(() => process.emit("SIGINT"), 200)
    await expect(running).resolves.toBe(0)
  })

  // An IDE's stop button, or a supervisor, signals the starter alone.
  it.skipIf(process.platform === "win32").each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("passes on a %s sent to the starter alone", async (signal, status) => {
    const running = runCliProgram(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"])
    setTimeout(() => process.emit(signal), 300)
    await expect(running).resolves.toBe(status)
  })

  it("rejects when the program cannot be started", async () => {
    await expect(runCliProgram(join(tmpdir(), "supatype-no-such-program"), [])).rejects.toThrow(/ENOENT/)
  })

  it("leaves no signal handlers behind", async () => {
    const before = process.listenerCount("SIGINT")
    await runCliProgram(process.execPath, ["-e", ""])
    expect(process.listenerCount("SIGINT")).toBe(before)
  })
})
