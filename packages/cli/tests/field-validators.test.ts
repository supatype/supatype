import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  declaredValidators,
  hooksReport,
  manifestValidators,
  validateModelValidators,
} from "../src/model-hooks.js"
import { extractSchemaAstFromTypes } from "../src/type-extractor.js"

// A per-field validator that silently never fires is the failure this feature cannot have: the
// schema would say the field is checked and nothing would be checking it. So the tests here are
// mostly about the ways that could happen, and each one fails the push instead.

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function extract(meta: string, fields = "  id: UUID\n  sku: string\n  setupItems: JSON<{ label: string }[]>"): unknown {
  const dir = mkdtempSync(join(tmpdir(), "supatype-validators-"))
  dirs.push(dir)
  const schemaPath = join(dir, "schema.ts")
  writeFileSync(
    schemaPath,
    `
import type { JSON, Model, Public, UUID } from "@supatype/types"

export type Product = Model<{
${fields}
}, {
  access: { read: Public }
${meta}
}>
`,
    "utf8",
  )
  return extractSchemaAstFromTypes(schemaPath, dir)
}

/** A functions directory containing the named handlers. */
function functionsDir(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-fns-"))
  dirs.push(dir)
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, "index.ts"), "export default () => new Response()", "utf8")
  }
  return dir
}

describe("declaring a field validator", () => {
  it("extracts the field and its function", () => {
    const ast = extract('  validate: { setupItems: "check-items" }')
    expect(declaredValidators(ast)).toEqual([
      { model: "Product", field: "setupItems", function: "check-items" },
    ])
  })

  it("accepts per-validator options, as hooks do", () => {
    const ast = extract('  validate: { sku: { function: "check-sku", timeout: 3000 } }')
    const manifest = manifestValidators(ast)
    expect(manifest["product"]?.["sku"]).toEqual({
      function: "check-sku",
      timeout: 3000,
      onUnavailable: "reject",
    })
  })

  it("writes onUnavailable explicitly rather than relying on the server's default", () => {
    // The server does default to refusing, but its policy matches exact event names, and a value
    // missing from that switch is how an unreachable validator came to accept writes once already.
    const ast = extract('  validate: { setupItems: "check-items" }')
    expect(manifestValidators(ast)["product"]?.["setupItems"]?.onUnavailable).toBe("reject")
  })

  it("refuses a validator naming a field the model does not have", () => {
    // Caught here, where the message can list the real fields, rather than becoming a manifest entry
    // for a column that will never appear in a write.
    expect(() => extract('  validate: { noSuchField: "check-it" }')).toThrow(
      /names "noSuchField", which is not a field on this model.*id, sku, setupItems/s,
    )
  })

  it("refuses a validate block that is not an object", () => {
    expect(() => extract("  validate: string")).toThrow(/`validate` must be an object/)
  })

  it("emits nothing when a model declares none", () => {
    const ast = extract("")
    expect(declaredValidators(ast)).toEqual([])
    expect(manifestValidators(ast)).toEqual({})
  })
})

describe("push refuses a validator whose function is missing", () => {
  it("names the field and where the function should be", () => {
    const ast = extract('  validate: { setupItems: "check-items" }')
    const problems = validateModelValidators(ast, functionsDir("something-else"), process.cwd())

    expect(problems.join("\n")).toMatch(/Product\.setupItems → "check-items"/)
    expect(problems.join("\n")).toMatch(/something-else/)
  })

  it("says nothing when every function exists", () => {
    const ast = extract('  validate: { setupItems: "check-items" }')
    expect(validateModelValidators(ast, functionsDir("check-items"), process.cwd())).toEqual([])
  })
})

describe("doctor reports what will and will not run", () => {
  it("separates a missing validator from a missing hook", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-doctor-"))
    dirs.push(cwd)
    const ast = extract('  validate: { setupItems: "check-items", sku: "check-sku" }')

    const report = hooksReport(cwd, functionsDir("check-sku"), ast)

    expect(report.validators).toHaveLength(2)
    expect(report.validatorsMissing.map((v) => v.field)).toEqual(["setupItems"])
    // A validator problem is not a hook problem: the fix and the consequence differ.
    expect(report.missing).toEqual([])
  })

  it("notices a manifest with no validator map, which means nothing is being checked", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supatype-doctor-"))
    dirs.push(cwd)
    mkdirSync(join(cwd, ".supatype"), { recursive: true })
    writeFileSync(join(cwd, ".supatype", "manifest.json"), JSON.stringify({ hooks: {} }), "utf8")

    const ast = extract('  validate: { setupItems: "check-items" }')
    const report = hooksReport(cwd, functionsDir("check-items"), ast)

    expect(report.validatorMapMissing).toBe(true)
  })
})
