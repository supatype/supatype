/**
 * The framework bindings' building blocks live on `@supatype/client/bindings`, not the main entry.
 *
 * `watchTable`, `runMutation` and their helpers exist so the bindings share one copy of the
 * channel wiring and the mutation requests. On the main entry they read as API an app should call,
 * and anything exported there is a promise to every app. The subpath keeps them available to the
 * bindings without that.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import * as main from "../src/index.js"
import * as bindings from "../src/bindings.js"

const BINDING_EXPORTS = [
  "watchTable",
  "subscribeToTable",
  "subscriptionViewOf",
  "applyRowChange",
  "isClientFor",
  "isRowsOf",
  "isCallerValue",
  "runMutation",
]

describe("entry points", () => {
  it("keeps the binding helpers off the main entry", () => {
    for (const name of BINDING_EXPORTS) expect(main, name).not.toHaveProperty(name)
  })

  it("exports every binding helper from the bindings entry", () => {
    for (const name of BINDING_EXPORTS) expect(bindings, name).toHaveProperty(name)
  })

  it("maps ./bindings in package.json to the built entry and its types", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(pkg).toHaveProperty(["exports", "./bindings"], { types: "./dist/bindings.d.ts", import: "./dist/bindings.js" })
  })
})
