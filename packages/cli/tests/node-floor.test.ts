import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isShape, isString } from "@supatype/shared"
import { parseJsonAs } from "./support/json.js"
import { NODE_FLOOR, nodeVersionRefusal } from "../bin/node-version.js"

/**
 * The oldest Node the published package runs on, and what an older one is told.
 *
 * 0.9.1 release test (RB7): 0.8.0 to 0.9.1 declared `engines.node: ">=22"`, which the code never
 * needed. npm prefers an older version whose `engines` the running Node meets over a newer one it
 * does not, so `npm install -g @supatype/cli` on Node 20 quietly installed 0.7.0, the newest
 * version with no `engines` at all. Installed from npm the package is only a starter for the
 * compiled program, and the starter, the bin script and the postinstall run on Node 18: Node 16
 * has no global `fetch`, which the first run uses to download the program.
 */

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..")

const isEnginesPackage = isShape({ engines: isShape({ node: isString }) })

describe("the published CLI package", () => {
  it("asks npm for Node 18 or later, the oldest its starter runs on", () => {
    const pkg = parseJsonAs(readFileSync(join(cliDir, "package.json"), "utf8"), isEnginesPackage)
    expect(pkg.engines.node).toBe(">=18")
    expect(pkg.engines.node).toBe(`>=${NODE_FLOOR}`)
  })
})

describe("the startup check in bin/node-version.js", () => {
  it("refuses a Node below the floor with one line naming both versions", () => {
    expect(nodeVersionRefusal("16.20.2")).toBe(
      "Supatype's CLI needs Node.js 18 or later; this is Node.js 16.20.2. Install a newer Node from https://nodejs.org",
    )
    expect(nodeVersionRefusal("12.22.12")).toContain("this is Node.js 12.22.12")
  })

  it("lets the floor and anything newer through", () => {
    expect(nodeVersionRefusal("18.0.0")).toBeNull()
    expect(nodeVersionRefusal("20.20.2")).toBeNull()
    expect(nodeVersionRefusal("22.23.4")).toBeNull()
    expect(nodeVersionRefusal("100.0.0")).toBeNull()
  })
})
