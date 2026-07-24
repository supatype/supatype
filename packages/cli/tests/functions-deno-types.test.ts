import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ensureFunctionsDenoTypes,
  functionsDenoAmbientSource,
  functionsTsConfigSource,
} from "../src/functions-deno-types.js"

describe("ensureFunctionsDenoTypes", () => {
  let tmpRoot = ""

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = ""
  })

  it("writes deno.d.ts and tsconfig.json under functions/", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supatype-deno-types-"))
    const functionsDir = join(tmpRoot, "functions")

    const result = ensureFunctionsDenoTypes(tmpRoot, functionsDir)

    expect(result.wroteDenoDts).toBe(true)
    expect(result.wroteTsconfig).toBe(true)
    expect(existsSync(join(functionsDir, "deno.d.ts"))).toBe(true)
    expect(existsSync(join(functionsDir, "tsconfig.json"))).toBe(true)
    expect(readFileSync(join(functionsDir, "deno.d.ts"), "utf8")).toContain("declare namespace Deno")
    expect(readFileSync(join(functionsDir, "tsconfig.json"), "utf8")).toContain('"types": []')
  })

  it("is idempotent when files already exist", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supatype-deno-types-"))
    const functionsDir = join(tmpRoot, "functions")
    mkdirSync(functionsDir, { recursive: true })
    writeFileSync(join(functionsDir, "deno.d.ts"), "// custom\n", "utf8")
    writeFileSync(join(functionsDir, "tsconfig.json"), "{}\n", "utf8")

    const result = ensureFunctionsDenoTypes(tmpRoot, functionsDir)

    expect(result.wroteDenoDts).toBe(false)
    expect(result.wroteTsconfig).toBe(false)
    expect(readFileSync(join(functionsDir, "deno.d.ts"), "utf8")).toBe("// custom\n")
  })

  it("adds functions to root tsconfig exclude when possible", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supatype-deno-types-"))
    writeFileSync(
      join(tmpRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true },
        include: ["**/*.ts"],
        exclude: ["node_modules"],
      }, null, 2),
      "utf8",
    )
    const functionsDir = join(tmpRoot, "functions")

    const result = ensureFunctionsDenoTypes(tmpRoot, functionsDir)

    expect(result.rootExclude).toBe("updated")
    const root = JSON.parse(readFileSync(join(tmpRoot, "tsconfig.json"), "utf8")) as {
      exclude: string[]
    }
    expect(root.exclude).toContain("functions")
    expect(root.exclude).toContain("node_modules")
  })

  it("reports already when functions is already excluded", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supatype-deno-types-"))
    writeFileSync(
      join(tmpRoot, "tsconfig.json"),
      JSON.stringify({ exclude: ["node_modules", "functions"] }, null, 2),
      "utf8",
    )

    const result = ensureFunctionsDenoTypes(tmpRoot, join(tmpRoot, "functions"))
    expect(result.rootExclude).toBe("already")
  })

  it("templates include Deno.env", () => {
    expect(functionsDenoAmbientSource()).toContain("const env: DenoEnv")
    expect(functionsTsConfigSource()).toContain("deno.d.ts")
  })
})
