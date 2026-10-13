/**
 * The framework bindings' building blocks live on `@supatype/client/bindings`, not the main entry.
 *
 * `watchTable` and its helpers exist so the Vue, Svelte and Solid bindings share one copy of the
 * channel wiring. On the main entry they read as API an app should call, and anything exported
 * there is a promise to every app. The subpath keeps them available to the bindings without that.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import * as main from "../src/index.js"
import * as bindings from "../src/bindings.js"

const BINDING_EXPORTS = ["watchTable", "subscribeToTable", "subscriptionViewOf", "applyRowChange"]

interface PackageJson {
  exports: Record<string, { types?: string; import?: string }>
}

describe("entry points", () => {
  it("keeps the binding helpers off the main entry", () => {
    for (const name of BINDING_EXPORTS) expect(main, name).not.toHaveProperty(name)
  })

  it("exports every binding helper from the bindings entry", () => {
    for (const name of BINDING_EXPORTS) expect(bindings, name).toHaveProperty(name)
  })

  it("maps ./bindings in package.json to the built entry and its types", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson
    expect(pkg.exports["./bindings"]).toEqual({ types: "./dist/bindings.d.ts", import: "./dist/bindings.js" })
  })
})
