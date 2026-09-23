import { describe, expect, it } from "vitest"

import { archiveNameCandidates } from "../src/binary-cache.js"

/**
 * `supatype-postgres` published the Intel macOS archive as `darwin-x86_64` while the CLI asks for
 * `darwin-amd64`: the spelling it derives from `process.arch === "x64"` on every platform. So
 * `supatype dev` on an Intel Mac failed with "Checksum not found", and had done for as long as both
 * sides existed: CI could not run Docker on a macOS runner, so the path was never exercised.
 *
 * Accepting both names means releases already on the CDN work untouched, rather than needing a fresh
 * one cut purely to rename a file.
 */
describe("archiveNameCandidates", () => {
  it("asks for the canonical amd64 name first on Intel macOS", () => {
    const names = archiveNameCandidates("postgres", "17.2", { os: "darwin", arch: "amd64" })
    expect(names[0]).toBe("supatype-pg-17-darwin-amd64.tar.gz")
  })

  it("falls back to the legacy x86_64 spelling", () => {
    const names = archiveNameCandidates("postgres", "17.2", { os: "darwin", arch: "amd64" })
    expect(names).toContain("supatype-pg-17-darwin-x86_64.tar.gz")
  })

  it("offers one name everywhere else, since only darwin ever disagreed", () => {
    // linux-amd64 and windows-amd64 always matched, so widening them would invite a wrong archive to
    // be accepted for a platform that never had a second name.
    expect(archiveNameCandidates("postgres", "17.2", { os: "linux", arch: "amd64" })).toEqual([
      "supatype-pg-17-linux-amd64.tar.gz",
    ])
    expect(archiveNameCandidates("postgres", "17.2", { os: "darwin", arch: "arm64" })).toEqual([
      "supatype-pg-17-darwin-arm64.tar.gz",
    ])
  })

  it("does not widen other components", () => {
    // Only the postgres archives were ever published under two names.
    expect(archiveNameCandidates("engine", "0.4.2", { os: "darwin", arch: "amd64" })).toEqual([
      "supatype-engine-darwin-amd64",
    ])
  })
})
