import { afterEach, describe, expect, it, vi } from "vitest"
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
      "@supatype/cli": { latest: "0.1.3", versions: ["0.1.1", "0.1.3"] },
      "@supatype/types": { latest: "0.1.3", versions: ["0.1.1", "0.1.3"] },
    })

    const deps = await resolveInitDependencyVersions()
    expect(deps.cli).toBe("0.1.3")
    expect(deps.types).toBe("0.1.3")
  })

  it("falls back to npm latest when the running CLI version is unpublished", async () => {
    mockRegistry({
      "@supatype/cli": { latest: "0.1.1", versions: ["0.1.1"] },
      "@supatype/types": { latest: "0.1.1", versions: ["0.1.1"] },
    })

    const deps = await resolveInitDependencyVersions()
    expect(deps.cli).toBe("0.1.1")
    expect(deps.types).toBe("0.1.1")
  })

  it("can pin cli and types to different published versions", async () => {
    mockRegistry({
      "@supatype/cli": { latest: "0.1.3", versions: ["0.1.1", "0.1.3"] },
      "@supatype/types": { latest: "0.1.1", versions: ["0.1.1"] },
    })

    const deps = await resolveInitDependencyVersions()
    expect(deps.cli).toBe("0.1.3")
    expect(deps.types).toBe("0.1.1")
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
