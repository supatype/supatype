import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/cli-package-version.js", () => ({ cliPackageVersion: () => "0.9.0" }))

import {
  initDependencyVersionsFallback,
  resolveInitDependencyVersions,
} from "../src/init-dependency-versions.js"

function mockRegistry(packages: Record<string, { latest: string; versions: string[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const name = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""))
      const pkg = packages[name]
      if (!pkg) return new Response(null, { status: 404 })
      const versions = Object.fromEntries(pkg.versions.map((v) => [v, {}]))
      return Response.json({ versions, "dist-tags": { latest: pkg.latest } })
    }),
  )
}

describe("resolveInitDependencyVersions", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("uses the running CLI version when both packages publish it", async () => {
    mockRegistry({
      "@supatype/cli": { latest: "0.10.0", versions: ["0.1.1", "0.9.0", "0.10.0"] },
      "@supatype/types": { latest: "0.10.0", versions: ["0.1.1", "0.9.0", "0.10.0"] },
    })

    const deps = await resolveInitDependencyVersions()
    expect(deps.cli).toBe("0.9.0")
    expect(deps.types).toBe("0.9.0")
  })

  // 0.9.2 release test round 2 (R2-S5): while 0.9.2 was not yet on npm, init pinned
  // `@supatype/cli ^0.9.1` and `@supatype/types ^0.9.1` (npm's latest) next to
  // `@supatype/client ^0.9.2`. The three are released together, so none is older than the CLI.
  it("never picks a package older than the running CLI", async () => {
    mockRegistry({
      "@supatype/cli": { latest: "0.8.0", versions: ["0.8.0"] },
      "@supatype/types": { latest: "0.8.0", versions: ["0.8.0"] },
      "@supatype/client": { latest: "0.8.0", versions: ["0.8.0"] },
    })

    expect(await resolveInitDependencyVersions()).toEqual({ cli: "0.9.0", types: "0.9.0", client: "0.9.0" })
  })

  it("never picks a pre-release of the running CLI's own version", async () => {
    const rc = { latest: "0.9.0-rc.3", versions: ["0.9.0-rc.3"] }
    mockRegistry({ "@supatype/cli": rc, "@supatype/types": rc, "@supatype/client": rc })

    expect(await resolveInitDependencyVersions()).toEqual({ cli: "0.9.0", types: "0.9.0", client: "0.9.0" })
  })

  // A CLI built from source whose version npm never had: npm's newer latest is installable, its own is not.
  it("keeps a package newer than an unpublished running CLI", async () => {
    const newer = { latest: "0.10.0", versions: ["0.10.0"] }
    mockRegistry({ "@supatype/cli": newer, "@supatype/types": newer, "@supatype/client": newer })

    expect(await resolveInitDependencyVersions()).toEqual({ cli: "0.10.0", types: "0.10.0", client: "0.10.0" })
  })

  it("falls back to the running CLI version when the registry is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })))
    expect(await resolveInitDependencyVersions()).toEqual(initDependencyVersionsFallback())
  })

  // npm and pnpm hand their configured registry to scripts as npm_config_registry, and a project
  // behind a mirror installs from it. Asking registry.npmjs.org regardless reached the internet from
  // a machine that may not, and named versions the mirror may not have.
  it("asks the registry npm is configured with", async () => {
    vi.stubEnv("npm_config_registry", "http://mirror.test/npm/")
    const asked: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url)
        return new Response(null, { status: 404 })
      }),
    )
    try {
      await resolveInitDependencyVersions()
    } finally {
      vi.unstubAllEnvs()
    }
    expect(asked.sort()).toEqual([
      "http://mirror.test/npm/%40supatype%2Fcli",
      "http://mirror.test/npm/%40supatype%2Fclient",
      "http://mirror.test/npm/%40supatype%2Ftypes",
    ])
  })
})
