import { afterEach, describe, expect, it, vi } from "vitest"
import {
  detectCliInstallMethod,
  looksLikeHomebrewCLI,
  looksLikeNpmOrWorkspaceCLI,
} from "../src/cli-install-method.js"

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
})
