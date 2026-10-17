import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { functionsDenoAmbientSource } from "../src/functions-deno-types.js"

/**
 * The Deno ambient types exist twice: published as `@supatype/cli/deno` (`deno.d.ts` at the package
 * root) and written into a project's `functions/deno.d.ts` by the scaffold. Only their header
 * comments differ. A declaration added to one and not the other (the `node:async_hooks` slice the
 * router imports, say) types a function differently depending on which file its editor read.
 */
const FIRST_DECLARATION = "interface DenoEnv {"

function declarations(source: string): string {
  const start = source.indexOf(FIRST_DECLARATION)
  expect(start).toBeGreaterThan(-1)
  return source.slice(start).replace(/\r\n/g, "\n").trimEnd()
}

describe("Deno ambient types", () => {
  it("declare the same things in the published file and the scaffolded one", () => {
    const published = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "deno.d.ts"), "utf8")
    expect(declarations(functionsDenoAmbientSource())).toBe(declarations(published))
  })
})
