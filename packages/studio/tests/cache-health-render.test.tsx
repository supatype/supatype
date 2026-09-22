import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CacheHealthPanels } from "../src/views/CacheHealthPanels.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import type { SupatypeClient } from "@supatype/client"

// Typecheck says the panels are well typed; it does not say they render. Static markup runs no
// effects, so this is the first paint — before any statistics have arrived, which is the state
// most likely to be written and never looked at. A "loading" that returns undefined, or a hook
// reading a context that is not there, both pass tsc and fail on screen.

const client = { url: "http://localhost:8000/studio/proxy" } as unknown as SupatypeClient

describe("the first paint, before any numbers", () => {
  it("renders, and says it is reading rather than showing empty panels", () => {
    const html = renderToStaticMarkup(
      <AdminClientContext.Provider value={client}>
        <CacheHealthPanels />
      </AdminClientContext.Provider>,
    )
    expect(html).toContain("Reading cache statistics")
    // No dashes-everywhere skeleton: a panel of "—" before the first read is indistinguishable
    // from a cache that has nothing to report, which is rule 4's mistake in a different costume.
    expect(html).not.toContain("Hit rate")
  })
})
