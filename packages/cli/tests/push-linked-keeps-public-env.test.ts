import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeAppliedAstArtifacts } from "../src/applied-ast-artifacts.js"
import type { DeployTarget } from "../src/resolve-target.js"
import { isJsonObject } from "@supatype/shared"
import { parseJsonAs } from "./support/json.js"
import { projectConfig } from "./support/project-config.js"

/**
 * D-90: a linked push sends the production public values to the server, then wrote the `local`
 * values into ./.supatype/manifest.json, which the self-host stack in the same folder serves. The
 * linked branch must leave that manifest's public values alone, and a push to the project's own
 * stack must still write them.
 */
vi.mock("../src/type-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/type-generation.js")>()),
  writeGeneratedTypes: async () => ["Types written"],
}))
vi.mock("../src/ui/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/progress.js")>()),
  withSpinner: async (_label: string, run: () => Promise<unknown>) => run(),
}))
vi.mock("../src/ui/messages.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, ...Object.fromEntries(Object.keys(original).map((name) => [name, () => {}])) }
})

const { finishTargetPush } = await import("../src/commands/push.js")

const config = projectConfig({
  project: { name: "acme" },
  build: { publicEnv: { SITE: { local: "http://localhost", production: "https://acme.example" }, LOCAL_ONLY: "dev" } },
})
const AST = { astVersion: 2, models: [] }
const PRODUCTION = { SITE: "https://acme.example", PRODUCTION_ONLY: "keep-me" }

function target(mode: "cloud" | "self-host"): DeployTarget {
  return { mode, environment: "production", projectRef: "acme", apiBaseUrl: "https://acme.example", apiPrefix: "/platform/v1", link: null }
}

let cwd = ""
const manifest = (): Record<string, unknown> => parseJsonAs(readFileSync(join(cwd, ".supatype", "manifest.json"), "utf8"), isJsonObject)

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-push-linked-env-"))
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  writeFileSync(join(cwd, ".supatype", "manifest.json"), JSON.stringify({ functions_enabled: true, public_env: PRODUCTION }))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe("a linked push leaves the manifest's public values alone", () => {
  it.each(["cloud", "self-host"] as const)("%s keeps the production values and a production-only key", async (mode) => {
    await finishTargetPush({ cwd, config, target: target(mode), ast: AST }, { status: "applied" }, false)
    expect(manifest()["public_env"]).toEqual(PRODUCTION)
  })
})

describe("writeAppliedAstArtifacts", () => {
  it("writes the local values by default, as a push to the project's own stack does", () => {
    const { lines } = writeAppliedAstArtifacts(cwd, config, AST, { rowCacheEnv: false })
    expect(manifest()["public_env"]).toEqual({ SITE: "http://localhost", LOCAL_ONLY: "dev" })
    expect(lines).toContain("Public values written to .supatype/manifest.json")
  })

  it("leaves them alone, and says nothing about them, when asked to skip the public values", () => {
    const { lines } = writeAppliedAstArtifacts(cwd, config, AST, { rowCacheEnv: false, syncPublicEnv: false })
    expect(manifest()["public_env"]).toEqual(PRODUCTION)
    expect(lines).not.toContain("Public values written to .supatype/manifest.json")
  })
})
