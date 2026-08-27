import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncComposeImagePins, upsertDevComposeEnv } from "../src/dev-compose.js"
import {
  LOCAL_SERVER_DOCKER_IMAGE,
  usesLocalServerImage,
} from "../src/compose-local-server-image.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * `overrides.server` has to survive the next `.env` write, whichever command makes it.
 *
 * The local image reaches compose through one variable, and several code paths rewrite the file
 * that holds it. When only one of them knew the local image existed, the others removed the key as
 * an unpinned managed pin: `dev` started the local server, the next `push` deleted the variable,
 * and compose recreated the container from the published image. Nothing failed, so the symptom was
 * a contributor testing their own build and running someone else's.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project whose `overrides.server` points at a binary beside a Dockerfile. */
function project(versions?: SupatypeProjectConfig["versions"]): {
  cwd: string
  config: SupatypeProjectConfig
} {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-local-image-"))
  dirs.push(cwd)
  const serverRoot = join(cwd, "server-src")
  mkdirSync(serverRoot, { recursive: true })
  writeFileSync(join(serverRoot, "Dockerfile"), "FROM scratch\n", "utf8")

  return {
    cwd,
    config: {
      project: { name: "demo" },
      ...(versions !== undefined && { versions }),
      overrides: { server: join(serverRoot, "supatype-server.exe") },
    } as SupatypeProjectConfig,
  }
}

const envOf = (cwd: string): string => readFileSync(join(cwd, ".env"), "utf8")

describe("the locally built server image", () => {
  it("is recognised from config alone, so no caller has to be told about it", () => {
    const { cwd, config } = project({ server: "local" })
    expect(usesLocalServerImage(cwd, config)).toBe(true)
  })

  it("is not claimed when the override points nowhere near a Dockerfile", () => {
    const { cwd, config } = project({ server: "local" })
    const stray = { ...config, overrides: { server: join(cwd, "nope", "server.exe") } }
    expect(usesLocalServerImage(cwd, stray as SupatypeProjectConfig)).toBe(false)
  })

  it("is not claimed when versions.server names a release", () => {
    const { cwd, config } = project({ server: "1.2.3" })
    expect(usesLocalServerImage(cwd, config)).toBe(false)
  })

  it("survives an image-pin sync that knows nothing about it", () => {
    // The exact sequence that broke: `dev` writes the local image, then another command rewrites
    // `.env` to reconcile pins from `versions`. The second command has no local image of its own,
    // so the first must not leave the key looking like a pin the second is entitled to remove.
    const { cwd, config } = project({ server: "local" })
    writeFileSync(join(cwd, ".env"), "JWT_SECRET=x\n", "utf8")

    upsertDevComposeEnv(cwd, config, "anon-key", "service-key", 54321)
    expect(envOf(cwd)).toContain(`SUPATYPE_SERVER_IMAGE=${LOCAL_SERVER_DOCKER_IMAGE}`)

    syncComposeImagePins(cwd, { project: { name: "demo" } } as SupatypeProjectConfig)
    expect(envOf(cwd)).toContain(`SUPATYPE_SERVER_IMAGE=${LOCAL_SERVER_DOCKER_IMAGE}`)
  })

  it("is cleared once the project stops asking for a local build", () => {
    // Otherwise compose keeps starting a stale `local-dev` image that nothing rebuilds.
    const { cwd, config } = project({ server: "local" })
    writeFileSync(join(cwd, ".env"), "JWT_SECRET=x\n", "utf8")
    upsertDevComposeEnv(cwd, config, "anon-key", "service-key", 54321)

    const released = { ...config, versions: { server: "1.2.3" } } as SupatypeProjectConfig
    upsertDevComposeEnv(cwd, released, "anon-key", "service-key", 54321)

    expect(envOf(cwd)).not.toContain(LOCAL_SERVER_DOCKER_IMAGE)
  })
})
