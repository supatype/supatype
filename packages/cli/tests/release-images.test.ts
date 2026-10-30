/**
 * Every Supatype image a stack runs is the one the CLI release was tested with, never `:latest`.
 *
 * `:latest` moved under a stack that had not changed, and a machine holding an old `:latest` ran it
 * without pulling: `supatype dev` ran a month-old local server that way. Now the engine, server and
 * Postgres come from release/images.json (the pins the release train tested), and the five images
 * built in this repository carry the CLI's own version. A build that is not a release has no images
 * of its own version, so it runs `:latest` for those five and still the exact pins for the rest.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PINNED_IMAGES } from "../src/generated/release-images.js"
import { defaultComponentVersion, isReleaseVersion, RELEASE_IMAGES, releaseImages } from "../src/release-images.js"
import { renderSelfHostCompose, schemaEngineImageForPush } from "../src/self-host-compose.js"
import { resolveVersionFor } from "../src/binary-cache.js"
import { projectConfig } from "./support/project-config.js"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("release/images.json", () => {
  it("is what the CLI was generated from", () => {
    const pins: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "release", "images.json"), "utf8"))
    expect(pins).toEqual(PINNED_IMAGES)
  })
})

describe("releaseImages()", () => {
  it("runs every in-repo image at the release's own version", () => {
    expect(releaseImages("0.7.0")).toEqual({
      engine: `supatype/schema-engine:${PINNED_IMAGES.engine.tag}`,
      server: `supatype/server:${PINNED_IMAGES.server.tag}`,
      postgres: `supatype/postgres:${PINNED_IMAGES.postgres.tag}`,
      studio: "supatype/studio:0.7.0",
      storage: "supatype/storage:0.7.0",
      realtime: "supatype/realtime:0.7.0",
      "functions-worker": "supatype/functions-worker:0.7.0",
      "control-plane": "supatype/control-plane:0.7.0",
    })
  })

  it("runs a prerelease's own images, which the release workflow publishes", () => {
    expect(releaseImages("0.8.0-rc.1").studio).toBe("supatype/studio:0.8.0-rc.1")
  })

  it.each(["", "0.8.0-dev.3", "0.8.0-local", "0.0.0-dev+abc123"])(
    "runs :latest for the in-repo images of a build that is not a release (%j), and exact pins for the rest",
    (version) => {
      const images = releaseImages(version)
      expect(images.studio).toBe("supatype/studio:latest")
      expect(images["control-plane"]).toBe("supatype/control-plane:latest")
      expect(images.server).toBe(`supatype/server:${PINNED_IMAGES.server.tag}`)
      expect(images.postgres).toBe(`supatype/postgres:${PINNED_IMAGES.postgres.tag}`)
      expect(images.engine).toBe(`supatype/schema-engine:${PINNED_IMAGES.engine.tag}`)
      expect(isReleaseVersion(version)).toBe(false)
    },
  )
})

describe("the compose file", () => {
  const compose = renderSelfHostCompose(projectConfig({ project: { name: "pins" }, database: { provider: "docker" } }))

  it.each([
    ["SUPATYPE_ENGINE_IMAGE", RELEASE_IMAGES.engine],
    ["SUPATYPE_POSTGRES_IMAGE", RELEASE_IMAGES.postgres],
    ["SUPATYPE_STUDIO_IMAGE", RELEASE_IMAGES.studio],
    ["SUPATYPE_STORAGE_IMAGE", RELEASE_IMAGES.storage],
    ["SUPATYPE_REALTIME_IMAGE", RELEASE_IMAGES.realtime],
    ["SUPATYPE_FUNCTIONS_WORKER_IMAGE", RELEASE_IMAGES["functions-worker"]],
    ["SUPATYPE_CONTROL_PLANE_IMAGE", RELEASE_IMAGES["control-plane"]],
  ])("defaults %s to the release's image", (key, image) => {
    expect(compose).toContain(`\${${key}:-${image}}`)
  })

  it("defaults the server to the pinned release, under both of its variables", () => {
    expect(compose).toContain(`\${SUPATYPE_SERVER_IMAGE:-\${SUPATYPE_AUTH_IMAGE:-${RELEASE_IMAGES.server}}}`)
  })

  it("never runs the engine, server or Postgres at :latest", () => {
    expect(compose).not.toMatch(/supatype\/(schema-engine|server|postgres):latest/)
  })
})

describe("what runs when the project names no version", () => {
  it("pushes with the pinned engine image, without asking the CDN", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")))
    const image = await schemaEngineImageForPush(projectConfig(), REPO_ROOT, {})
    expect(image).toBe(RELEASE_IMAGES.engine)
  })

  it.each([
    ["engine", PINNED_IMAGES.engine.tag.replace(/^v/, "")],
    ["server", PINNED_IMAGES.server.tag.replace(/^v/, "")],
    ["postgres", PINNED_IMAGES.postgres.tag.replace(/^v/, "")],
  ] as const)("downloads the pinned %s binary, without asking the CDN", async (component, version) => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")))
    await expect(resolveVersionFor(component, projectConfig())).resolves.toBe(version)
  })

  it("downloads realtime at the release's own version, and asks the CDN only for a build that is not one", () => {
    expect(defaultComponentVersion("realtime", "0.7.0")).toBe("0.7.0")
    expect(defaultComponentVersion("realtime", "")).toBeUndefined()
    expect(defaultComponentVersion("deno", "0.7.0")).toBeUndefined()
  })
})
