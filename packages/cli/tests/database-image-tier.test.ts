import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * A3-N1: with `database.image` set to a tag of `supatype/postgres` and no `versions.postgres`, the
 * CLI chose the view tier from the image's name, while compose ran `supatype/postgres:latest`,
 * which carries `supatype_mask`, so the engine chose the extension tier. PostgREST then pointed at
 * `api` views that were never made, and every model answered 404. Compose now runs the configured
 * image, and the tier comes from what that image carries, not from its name.
 */
const images = vi.hoisted(() => ({ local: new Map<string, boolean>(), runs: 0 }))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) => {
    if (cmd !== "docker") return { status: 1, stdout: "", stderr: "" }
    const image = args[args.length - 1] === "inspect" ? "" : args.find((a) => images.local.has(a)) ?? args[args.length - 1]!
    if (args[0] === "image" && args[1] === "inspect") return { status: images.local.has(image) ? 0 : 1, stdout: "", stderr: "" }
    if (args[0] === "run") {
      images.runs += 1
      const carries = [...images.local.entries()].find(([name]) => args.includes(name))?.[1]
      return { status: carries === true ? 0 : 1, stdout: "", stderr: "" }
    }
    return { status: 1, stdout: "", stderr: "" }
  },
}))

const { composeDockerImageEnv } = await import("../src/self-host-compose.js")
const { fieldMaskingTier } = await import("../src/field-masking-tier.js")

const MASKED = { models: [{ annotations: { platform: { access: { fields: { secret: { read: {} } } } } } }] }

function project(database: Record<string, unknown>, versions?: Record<string, string>): SupatypeProjectConfig {
  return {
    project: { name: "demo" },
    provider: "docker",
    database: { provider: "docker", ...database },
    server: { mode: "dev" },
    ...(versions !== undefined && { versions }),
  } as SupatypeProjectConfig
}

beforeEach(() => {
  images.local.clear()
  images.runs = 0
})

describe("database.image", () => {
  it("is the image compose runs, with no versions pinned", () => {
    expect(composeDockerImageEnv(project({ image: "postgres:17-alpine" }))["SUPATYPE_POSTGRES_IMAGE"]).toBe("postgres:17-alpine")
  })

  it("is the image compose runs alongside other pins", () => {
    const config = project({ image: "registry.example.com/pg:17" }, { engine: "0.6.0" })
    expect(composeDockerImageEnv(config)).toMatchObject({ SUPATYPE_POSTGRES_IMAGE: "registry.example.com/pg:17" })
  })

  it("leaves compose's default alone when no image is configured", () => {
    const config = project({})
    expect(composeDockerImageEnv(config)["SUPATYPE_POSTGRES_IMAGE"]).toBeUndefined()
    expect(fieldMaskingTier(config, MASKED)).toBe("extension")
  })
})

describe("the tier for a configured image", () => {
  it("is the extension tier for a retagged supatype/postgres that carries supatype_mask", () => {
    images.local.set("verify-a3/postgres:latest", true)
    expect(fieldMaskingTier(project({ image: "verify-a3/postgres:latest" }), MASKED)).toBe("extension")
  })

  it("is the view tier for an image without it", () => {
    images.local.set("postgres:17-alpine", false)
    expect(fieldMaskingTier(project({ image: "postgres:17-alpine" }), MASKED)).toBe("views")
  })

  it("asks each image once", () => {
    images.local.set("cached/pg:1", true)
    fieldMaskingTier(project({ image: "cached/pg:1" }), MASKED)
    fieldMaskingTier(project({ image: "cached/pg:1" }), MASKED)
    expect(images.runs).toBe(1)
  })

  it("goes by the name for an image that is not on this machine, rather than pulling it", () => {
    expect(fieldMaskingTier(project({ image: "elsewhere/pg:17" }), MASKED)).toBe("views")
    expect(images.runs).toBe(0)
  })
})
