import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerInternalCommands } from "../src/commands/internal.js"

/**
 * The standalone binary collects a seed by running `_collect-seed` on itself (issue 61): a snippet
 * in the temp directory cannot import the collector from the binary's embedded filesystem, so every
 * seed failed with `Cannot find module 'B:\~BUN\root\seed-ir.js'`.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-collect-seed-"))
  writeFileSync(join(dir, "builder.mjs"), `export const schemaFingerprint = "fp-2"\nexport const seedModels = {}\n`)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function collect(seedSource: string, environment?: string): Promise<unknown> {
  const file = join(dir, "seed.mjs")
  const outPath = join(dir, "ir.json")
  writeFileSync(file, seedSource)
  const program = new Command()
  registerInternalCommands(program)
  const job = { file, outPath, builderPath: join(dir, "builder.mjs"), ...(environment !== undefined && { environment }) }
  await program.parseAsync(["node", "supatype", "_collect-seed", JSON.stringify(job)])
  return JSON.parse(readFileSync(outPath, "utf8"))
}

describe("_collect-seed", () => {
  it("collects a default export with the CLI's own collector, expr and environment", async () => {
    const written = await collect(
      `export const config = { runOnce: true }\n` +
        `export default async ({ expr, environment }) => {\n` +
        `  if (typeof expr?.now !== "function") throw new Error("no expr")\n` +
        `  if (environment !== "staging") throw new Error("environment " + environment)\n` +
        `}\n`,
      "staging",
    )
    expect(written).toMatchObject({
      shape: "collected",
      ir: { irVersion: 1, schemaFingerprint: "fp-2", operations: [] },
      config: { runOnce: true },
    })
  })

  it("reports a module with no default export as the legacy shape", async () => {
    expect(await collect(`globalThis.ranLegacySeed = true\n`)).toEqual({ shape: "legacy" })
  })
})
