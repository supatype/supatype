import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { isShape, isString } from "@supatype/shared"
import { cliPackageVersion } from "../src/cli-package-version.js"
import { parseJsonAs } from "./support/json.js"

const packageJson = parseJsonAs(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
  isShape({ version: isString }),
)

describe("cliPackageVersion", () => {
  it("matches packages/cli/package.json version", () => {
    expect(cliPackageVersion()).toBe(packageJson.version)
  })
})
