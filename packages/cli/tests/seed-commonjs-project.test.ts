import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectSeed } from "../src/seed-runner.js"

/**
 * A seed file in a project without `"type": "module"` (a Next.js app, say) is CommonJS to tsx, so
 * its `import ... from "@supatype/cli/seed"` resolves with the `require` condition. The export map
 * offered only `import`, and the seed failed with ERR_PACKAGE_PATH_NOT_EXPORTED. Needs `pnpm build`.
 */

const CLI_PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..")
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-seed-cjs-"))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "next-app", private: true }))
  mkdirSync(join(dir, "node_modules", "@supatype"), { recursive: true })
  symlinkSync(CLI_PACKAGE, join(dir, "node_modules", "@supatype", "cli"), "junction")
  writeFileSync(join(dir, "builder.mjs"), `export const schemaFingerprint = "fp-1"\nexport const seedModels = {}\n`)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("a seed file in a CommonJS project", () => {
  it("imports types and values from @supatype/cli/seed", () => {
    const file = join(dir, "seed.ts")
    writeFileSync(
      file,
      [
        'import type { SeedContext } from "@supatype/cli/seed"',
        'import { expr } from "@supatype/cli/seed"',
        "",
        "export default async ({ log }: SeedContext) => {",
        '  if (typeof expr.now !== "function") throw new Error("no expr")',
        '  log("seeded")',
        "}",
        "",
      ].join("\n"),
    )
    const { result, stdout } = collectSeed(file, { cwd: dir, builderPath: join(dir, "builder.mjs") })
    expect(result).toMatchObject({ shape: "collected" })
    expect(stdout).toContain("seeded")
  })
})
