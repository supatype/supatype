import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeployTarget } from "../src/resolve-target.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * FF-20: a push to a linked Cloud or self-host project wrote no generated types and no seed
 * builder, so the next `supatype seed` was refused with "built against a different schema ... Run
 * supatype generate". Only a push to the project's own stack finished that step.
 */

const written: { cwd: string; typesPath: string | undefined; clientPath: string | undefined }[] = []

vi.mock("../src/type-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/type-generation.js")>()),
  writeGeneratedTypes: async (request: { cwd: string; typesPath?: string; clientPath?: string }) => {
    written.push({ cwd: request.cwd, typesPath: request.typesPath, clientPath: request.clientPath })
    return ["Types written"]
  },
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

const config: SupatypeProjectConfig = { project: { name: "acme" } }
const AST = { astVersion: 2, models: [] }

function linkedTarget(mode: "cloud" | "self-host"): DeployTarget {
  return { mode, environment: "production", projectRef: "acme", apiBaseUrl: "https://acme.example", apiPrefix: "/platform/v1", link: null }
}

let cwd = ""
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-push-linked-types-"))
})
afterEach(() => {
  written.length = 0
  rmSync(cwd, { recursive: true, force: true })
})

describe("a push to a linked project writes the generated types", () => {
  it.each(["cloud", "self-host"] as const)("%s", async (mode) => {
    await finishTargetPush({ cwd, config, target: linkedTarget(mode), ast: AST }, { status: "applied" }, false)
    expect(written.map((w) => w.cwd)).toEqual([cwd])
  })

  it("also when a step after the schema failed: the schema is applied", async () => {
    await finishTargetPush({ cwd, config, target: linkedTarget("cloud"), ast: AST }, { status: "applied" }, true)
    expect(written).toHaveLength(1)
  })
})
