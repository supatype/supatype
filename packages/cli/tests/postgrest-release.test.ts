import { describe, expect, it } from "vitest"
import type { PlatformId } from "../src/binary-cache.js"
import { validateProjectConfig } from "../src/project-config.js"
import {
  POSTGREST_IMAGE,
  POSTGREST_VERSION,
  postgrestArchiveName,
  postgrestArchiveUrl,
} from "../src/postgrest-release.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"

/**
 * The PostgREST every stack runs.
 *
 * Releases before 14.4 fail a PATCH or DELETE filtered with `or`/`and` whose `select` leaves out
 * the filtered column (PostgREST#3707): the client's `.update().or(...).select("id")` answered
 * `column ... does not exist` and wrote nothing. The fix was never backported, so the floor is a
 * version, and the compose image and the native download must both clear it.
 */

/** The first release with the PostgREST#3707 fix. */
const FIXED_IN = [14, 4] as const

function parseVersion(version: string): number[] {
  return version.split(".").map((part) => Number(part))
}

function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = parseVersion(version)
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0
    const need = floor[i] ?? 0
    if (have !== need) return have > need
  }
  return true
}

/** Every archive the v14.18 release publishes, as listed on its GitHub release page. */
const RELEASE_ASSETS = new Set([
  "postgrest-v14.18-freebsd-x86-64.tar.xz",
  "postgrest-v14.18-linux-static-x86-64.tar.xz",
  "postgrest-v14.18-macos-aarch64.tar.xz",
  "postgrest-v14.18-macos-x86-64.tar.xz",
  "postgrest-v14.18-ubuntu-aarch64.tar.xz",
  "postgrest-v14.18-windows-x86-64.zip",
])

const PLATFORMS: PlatformId[] = [
  { os: "linux", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "darwin", arch: "arm64" },
  { os: "windows", arch: "amd64" },
  { os: "windows", arch: "arm64" },
]

function composeImage(): string {
  const config = validateProjectConfig(
    {
      project: { name: "acme" },
      server: { mode: "dev" },
      app: { mode: "none" },
      database: { provider: "docker" },
      versions: { engine: "0.4.2", server: "0.1.0", postgres: "17.2", deno: DENO_RELEASE_PIN },
    },
    "supatype.config.ts",
  )
  const match = /^\s+image: (postgrest\/postgrest:\S+)$/m.exec(renderSelfHostCompose(config))
  if (match?.[1] === undefined) throw new Error("the compose file has no PostgREST image")
  return match[1]
}

describe("PostgREST release", () => {
  it("compose runs a release with the PostgREST#3707 fix", () => {
    const tag = composeImage().split(":v")[1] ?? ""
    expect(atLeast(tag, FIXED_IN), `postgrest/postgrest:v${tag}`).toBe(true)
  })

  it("compose and the native download run the same release", () => {
    expect(composeImage()).toBe(POSTGREST_IMAGE)
    expect(postgrestArchiveUrl({ os: "linux", arch: "amd64" })).toContain(`/v${POSTGREST_VERSION}/`)
  })

  it("names an archive the release actually publishes, on every platform", () => {
    for (const platform of PLATFORMS) {
      const name = postgrestArchiveName(platform, "14.18")
      expect(RELEASE_ASSETS.has(name), `${platform.os}/${platform.arch}: ${name}`).toBe(true)
    }
  })
})
