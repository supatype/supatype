import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defaultExportOf } from "../src/seed-default-export.js"

/** Decision D10: a seed file's default export is read from its text, never by importing it. */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-default-export-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function verdict(source: string): ReturnType<typeof defaultExportOf> {
  const file = join(dir, "seed.ts")
  writeFileSync(file, source)
  return defaultExportOf(file)
}

describe("defaultExportOf()", () => {
  it.each([
    ["an arrow function", "export default async () => {}"],
    ["a named function", "export default async function seed() {}"],
    ["an identifier", "const seed = async () => {}\nexport default seed"],
    ["a renamed export", "const seed = async () => {}\nexport { seed as default }"],
    ["a re-export", `export { default } from "./shared"`],
    ["a renamed re-export", `export { seed as default } from "./shared"`],
  ])("finds %s", (_name, source) => {
    expect(verdict(source)).toBe("present")
  })

  it.each([
    ["only named exports", "export const seed = 1"],
    ["a star re-export, which never carries a default", `export * from "./shared"`],
    ["work done on import", `import { writeFileSync } from "node:fs"\nwriteFileSync("x", "y")`],
  ])("finds none in %s", (_name, source) => {
    expect(verdict(source)).toBe("absent")
  })

  it("cannot tell for a file that does not parse", () => {
    expect(verdict("export default (((")).toBe("unknown")
  })

  it("cannot tell for a file that cannot be read", () => {
    expect(defaultExportOf(join(dir, "missing.ts"))).toBe("unknown")
  })
})
