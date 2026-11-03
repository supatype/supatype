import { afterEach, describe, expect, it, vi } from "vitest"
import {
  detectCliInstallMethod,
  looksLikeHomebrewCLI,
  looksLikeNpmOrWorkspaceCLI,
} from "../src/cli-install-method.js"
import { cliCachePath } from "../src/cli-program-path.js"

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
})

describe("looksLikeNpmOrWorkspaceCLI", () => {
  it("detects node_modules install path", () => {
    process.argv = ["node", "/usr/lib/node_modules/@supatype/cli/bin/supatype.js"]
    expect(looksLikeNpmOrWorkspaceCLI()).toBe(true)
  })

  it("detects workspace dist/cli path", () => {
    process.argv = ["node", "/repo/packages/cli/dist/cli.js"]
    expect(looksLikeNpmOrWorkspaceCLI()).toBe(true)
  })
})

describe("looksLikeHomebrewCLI", () => {
  it("detects macOS Cellar layout", () => {
    process.argv = [
      "node",
      "/opt/homebrew/Cellar/supatype/0.1.5/bin/supatype",
    ]
    expect(looksLikeHomebrewCLI()).toBe(true)
  })

  it("detects Linuxbrew via HOMEBREW_CELLAR", () => {
    vi.stubEnv("HOMEBREW_CELLAR", "/home/linuxbrew/.linuxbrew/Cellar")
    process.argv = [
      "node",
      "/home/linuxbrew/.linuxbrew/Cellar/supatype/0.1.5/bin/supatype",
    ]
    expect(looksLikeHomebrewCLI()).toBe(true)
  })

  it("does not flag standalone ~/.supatype/bin", () => {
    process.argv = ["node", "/Users/me/.supatype/bin/supatype"]
    expect(looksLikeHomebrewCLI()).toBe(false)
  })
})

describe("detectCliInstallMethod", () => {
  it("prefers npm over homebrew when both match", () => {
    process.argv = ["node", "/repo/packages/cli/dist/cli.js"]
    expect(detectCliInstallMethod()).toBe("npm")
  })

  it("returns standalone for curl|sh install path", () => {
    process.argv = ["node", "/Users/me/.supatype/bin/supatype"]
    expect(detectCliInstallMethod()).toBe("standalone")
  })

  it("returns homebrew for Cellar binary", () => {
    process.argv = ["node", "/opt/homebrew/Cellar/supatype/0.1.5/bin/supatype"]
    expect(detectCliInstallMethod()).toBe("homebrew")
  })

  // The npm package's starter runs a compiled program it keeps in the CLI cache. Replacing that
  // program would leave it at a different version from the package that starts it.
  it.each([
    ["linux", { os: "linux", arch: "amd64" }, "/$bunfs/root/supatype"],
    ["windows", { os: "windows", arch: "amd64" }, "B:/~BUN/root/supatype.exe"],
  ] as const)("returns npm for the program the npm starter runs on %s", (_, platform, embedded) => {
    // Run under vitest, the npm_* variables alone would answer npm whatever the path said.
    vi.stubEnv("npm_execpath", undefined)
    vi.stubEnv("npm_lifecycle_event", undefined)
    const program = cliCachePath("0.8.0", platform)
    const originalExecPath = process.execPath
    process.execPath = program
    process.argv = [program, embedded]
    try {
      expect(detectCliInstallMethod()).toBe("npm")
    } finally {
      process.execPath = originalExecPath
    }
  })
})
