import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ensureFunctionsDenoTypes,
  functionsDenoAmbientSource,
  functionsTsConfigSource,
} from "../src/functions-deno-types.js"

const require = createRequire(import.meta.url)

function resolveTscBin(): string {
  const typescriptEntry = require.resolve("typescript/package.json")
  return join(dirname(typescriptEntry), "bin", "tsc")
}

function runTsc(projectDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolveTscBin(), "-p", "tsconfig.json", "--pretty", "false"], {
    cwd: projectDir,
    encoding: "utf8",
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

const HANDLER_WITH_DENO = `export default async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPATYPE_URL")
  return new Response(JSON.stringify({ url, method: req.method }), {
    headers: { "Content-Type": "application/json" },
  })
}
`

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

/**
 * Manual / end-to-end check: real `tsc` against a scaffolded functions dir.
 * Proves Deno.env is typed (no TS2304) once deno.d.ts + functions/tsconfig exist.
 */
describe("functions Deno types (tsc manual check)", () => {
  let tmpRoot = ""

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = ""
  })

  it("tsc fails with Cannot find name Deno without ambient types", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supatype-deno-tsc-baseline-"))
    const fnDir = join(tmpRoot, "hello")
    mkdirSync(fnDir, { recursive: true })
    writeFileSync(join(fnDir, "index.ts"), HANDLER_WITH_DENO, "utf8")
    writeFileSync(
      join(tmpRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            strict: true,
            noEmit: true,
            module: "ESNext",
            moduleResolution: "bundler",
            types: [],
          },
          include: ["./**/*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    )

    const { status, stdout, stderr } = runTsc(tmpRoot)
    const out = `${stdout}\n${stderr}`
    expect(status).not.toBe(0)
    expect(out).toMatch(/Cannot find name 'Deno'|TS2304/)
  })

  it("tsc passes for Deno.env after ensureFunctionsDenoTypes", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supatype-deno-tsc-ok-"))
    const functionsDir = join(tmpRoot, "functions")
    mkdirSync(join(functionsDir, "hello"), { recursive: true })
    writeFileSync(join(functionsDir, "hello", "index.ts"), HANDLER_WITH_DENO, "utf8")
    writeFileSync(
      join(tmpRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            strict: true,
            noEmit: true,
            module: "ESNext",
            moduleResolution: "bundler",
          },
          include: ["**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
      "utf8",
    )

    const ensured = ensureFunctionsDenoTypes(tmpRoot, functionsDir)
    expect(ensured.wroteDenoDts).toBe(true)
    expect(ensured.wroteTsconfig).toBe(true)
    expect(ensured.rootExclude).toBe("updated")

    const { status, stdout, stderr } = runTsc(functionsDir)
    const out = `${stdout}\n${stderr}`
    expect(out, `tsc stderr/stdout:\n${out}`).not.toMatch(/Cannot find name 'Deno'|TS2304/)
    expect(status, `tsc failed:\n${out}`).toBe(0)
  })
})
