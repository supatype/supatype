import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeAppliedAstArtifacts } from "../src/applied-ast-artifacts.js"
import { syncManifestPublicEnv } from "../src/build-public-env.js"
import { projectConfig } from "./support/project-config.js"

/**
 * A local stack serves the values `build.publicEnv` gives its environment (`local`) from the
 * manifest's `public_env`, as a self-host stack's control plane writes them.
 */
let cwd = ""
const manifestPath = () => join(cwd, ".supatype", "manifest.json")
const readManifest = (): Record<string, unknown> => JSON.parse(readFileSync(manifestPath(), "utf8")) as Record<string, unknown>

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-manifest-public-env-"))
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  writeFileSync(manifestPath(), JSON.stringify({ functions_enabled: true }))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const withEnv = (publicEnv: Record<string, string | Record<string, string>>) => projectConfig({ build: { publicEnv } })

describe("syncManifestPublicEnv", () => {
  it("writes the values for the local environment and keeps the rest of the manifest", () => {
    const changed = syncManifestPublicEnv(cwd, withEnv({ A: "1", B: { local: "dev", production: "prod" }, C: { production: "p" } }))
    expect(changed).toBe(true)
    expect(readManifest()).toEqual({ functions_enabled: true, public_env: { A: "1", B: "dev" } })
  })

  it("says nothing changed when the manifest already has them", () => {
    syncManifestPublicEnv(cwd, withEnv({ A: "1" }))
    expect(syncManifestPublicEnv(cwd, withEnv({ A: "1" }))).toBe(false)
  })

  it("takes out what the config no longer names", () => {
    syncManifestPublicEnv(cwd, withEnv({ A: "1" }))
    expect(syncManifestPublicEnv(cwd, projectConfig())).toBe(true)
    expect("public_env" in readManifest()).toBe(false)
  })

  it("does not make a manifest the compose path owns", () => {
    rmSync(manifestPath())
    expect(syncManifestPublicEnv(cwd, withEnv({ A: "1" }))).toBe(false)
  })

  it("leaves a manifest it cannot read for the server to report", () => {
    writeFileSync(manifestPath(), "{not json")
    expect(syncManifestPublicEnv(cwd, withEnv({ A: "1" }))).toBe(false)
    expect(readFileSync(manifestPath(), "utf8")).toBe("{not json")
  })
})

describe("a push or dev start", () => {
  it("writes the values with the other artifacts, and says so", () => {
    const { lines } = writeAppliedAstArtifacts(cwd, withEnv({ A: "1" }), { models: [] }, { rowCacheEnv: false })
    expect(readManifest()["public_env"]).toEqual({ A: "1" })
    expect(lines).toContain("Public values written to .supatype/manifest.json")
  })
})
