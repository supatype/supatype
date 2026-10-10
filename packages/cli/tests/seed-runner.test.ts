import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectSeed } from "../src/seed-runner.js"

/**
 * The seed collector runs as a snippet in the user's temp directory (A5-N4), and still reaches the
 * CLI's own collector and `expr` from there.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-seed-runner-"))
  writeFileSync(join(dir, "builder.mjs"), `export const schemaFingerprint = "fp-1"\nexport const seedModels = {}\n`)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("collectSeed()", () => {
  it("reports a module with no default export as the legacy shape", () => {
    const file = join(dir, "seed.mjs")
    writeFileSync(file, `console.log("ran")\n`)
    const { result } = collectSeed(file, { cwd: dir, builderPath: join(dir, "builder.mjs") })
    expect(result).toEqual({ shape: "legacy" })
  })

  it("collects a default export through the CLI's own collector", () => {
    const file = join(dir, "seed.mjs")
    writeFileSync(file, `export default async ({ expr }) => { if (typeof expr?.now !== "function") throw new Error("no expr") }\n`)
    const { result } = collectSeed(file, { cwd: dir, builderPath: join(dir, "builder.mjs") })
    expect(result).toMatchObject({ shape: "collected", ir: { irVersion: 1, schemaFingerprint: "fp-1" } })
  })
})
