import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ensureDevApiConfig } from "../src/ensure-dev-api-config.js"

describe("ensureDevApiConfig()", () => {
  it("copies config/api-config.json when target is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-api-config-"))
    const configDir = join(dir, "config")
    const template = join(configDir, "api-config.json")
    const target = join(dir, ".supatype", "api-config.json")

    mkdirSync(configDir, { recursive: true })
    writeFileSync(template, '{"rest":{"schema":"public"}}\n', "utf8")

    expect(ensureDevApiConfig(dir)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, "utf8")).toContain('"rest"')
    expect(ensureDevApiConfig(dir)).toBe(false)
  })
})
