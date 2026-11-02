import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectSeed } from "../src/seed-runner.js"

/**
 * `export const config = { transaction: false }` was validated and then never sent: the engine
 * runs every seed document in a transaction and has no way to run one outside it. A seed asking
 * for it is refused rather than silently run in a transaction anyway.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-seed-config-"))
  writeFileSync(join(dir, "builder.mjs"), `export const schemaFingerprint = "fp-1"\nexport const seedModels = {}\n`)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function collect(config: string): () => unknown {
  const file = join(dir, "seed.mjs")
  writeFileSync(file, `export const config = ${config}\nexport default async () => {}\n`)
  return () => collectSeed(file, { cwd: dir, builderPath: join(dir, "builder.mjs") })
}

describe("a seed file's config", () => {
  it.each(["{ transaction: false }", "{ transaction: true }"])("refuses %s, naming the setting", (config) => {
    expect(collect(config)).toThrow(/config\.transaction.*not supported.*--atomic/s)
  })

  it("still takes runOnce", () => {
    expect(collect("{ runOnce: true }")()).toMatchObject({ result: { shape: "collected", config: { runOnce: true } } })
  })
})

describe("a seed file's config keys", () => {
  it("refuses a key the runner does not read, such as a misspelt runOnce", () => {
    expect(collect("{ runonce: true }")).toThrow(/config.*runonce.*may set: runOnce/s)
  })
})
