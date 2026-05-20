import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

const CLI_ROOT = resolve(import.meta.dirname, "..")
const REPO_ROOT = resolve(CLI_ROOT, "../..")

const EXAMPLE_CONFIGS = [
  "examples/blog/supatype.config.ts",
  "examples/self-host/supatype.config.ts",
  "tests/integration/supatype.config.ts",
]

describe("release-pins", () => {
  it("DENO_RELEASE_PIN matches releases/deno/VERSION", () => {
    const file = join(CLI_ROOT, "releases", "deno", "VERSION")
    expect(DENO_RELEASE_PIN).toBe(readFileSync(file, "utf8").trim())
  })

  it("example configs use the same deno pin", () => {
    const needle = `deno: "${DENO_RELEASE_PIN}"`
    for (const rel of EXAMPLE_CONFIGS) {
      const content = readFileSync(join(REPO_ROOT, rel), "utf8")
      expect(content, rel).toContain(needle)
    }
  })
})
