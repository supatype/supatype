import { beforeEach, describe, expect, it, vi } from "vitest"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

/**
 * A key under `server` that the config does not define used to be dropped without a word, so a typo
 * (`server.prot`) or a setting from another product did nothing and nobody was told. Until the
 * release that refuses it, it gets a warning that names the key and says so.
 */
const said = vi.hoisted(() => ({ warnings: [] as string[] }))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  warn: (message: string) => void said.warnings.push(message),
}))

function raw(server: Record<string, unknown>): Record<string, unknown> {
  return {
    project: { name: "acme" },
    server,
    app: { mode: "none" as const },
    database: { provider: "docker" as const },
    versions: { postgres: "17.2", deno: DENO_RELEASE_PIN },
  }
}

async function load(server: Record<string, unknown>): Promise<void> {
  const { validateProjectConfig } = await import("../src/project-config.js")
  validateProjectConfig(raw(server), "supatype.config.ts")
}

beforeEach(() => {
  said.warnings.length = 0
  vi.resetModules()
})

describe("an unknown key under server in the config", () => {
  it("warns, naming the key and saying the next release refuses it", async () => {
    await load({ mode: "dev", prot: 18471 })
    expect(said.warnings).toHaveLength(1)
    expect(said.warnings[0]).toContain("server.prot")
    expect(said.warnings[0]).toContain("next release refuses")
  })

  it("names every unknown key in one warning", async () => {
    await load({ mode: "dev", prot: 1, workers: 4 })
    expect(said.warnings).toHaveLength(1)
    expect(said.warnings[0]).toContain("server.prot")
    expect(said.warnings[0]).toContain("server.workers")
  })

  it("warns once however often the config is read", async () => {
    await load({ mode: "dev", prot: 1 })
    await load({ mode: "dev", prot: 1 })
    expect(said.warnings).toHaveLength(1)
  })

  it("says nothing for every key the config defines", async () => {
    await load({ mode: "standalone", port: 1, postgrestPort: 2, realtimePort: 3, public_env: true, domain: "a.example.com", tls: { provider: "kong" } })
    expect(said.warnings).toEqual([])
  })
})
