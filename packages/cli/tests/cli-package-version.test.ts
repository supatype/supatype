import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { cliPackageVersion } from "../src/cli-package-version.js"

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
) as { version: string }

describe("cliPackageVersion", () => {
  it("matches packages/cli/package.json version", () => {
    expect(cliPackageVersion()).toBe(packageJson.version)
  })
})
