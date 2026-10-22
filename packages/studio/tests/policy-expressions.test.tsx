import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PolicyTableCard } from "../src/components/database/PolicyTable.js"

/**
 * Fresh-test cosmetic: Storage Policies listed only the WITH CHECK clause of an UPDATE policy that
 * also had USING, so the rule deciding which rows may be updated was not on the screen. Each clause
 * a policy has is shown, labelled.
 */

const UPDATE_POLICY = {
  policyname: "owner_update",
  cmd: "UPDATE",
  permissive: "PERMISSIVE",
  qual: "(owner = auth.uid())",
  with_check: "(bucket_id = 'images'::text)",
}

function render(policy: Record<string, unknown>): string {
  return renderToStaticMarkup(<PolicyTableCard table={{ label: "storage.objects", rlsEnabled: true, policies: [policy] }} actions={null} />)
}

describe("a policy's expressions", () => {
  it("shows USING and WITH CHECK when a policy has both", () => {
    const html = render(UPDATE_POLICY)
    expect(html).toContain("USING")
    expect(html).toContain("(owner = auth.uid())")
    expect(html).toContain("WITH CHECK")
    expect(html).toContain("(bucket_id = &#x27;images&#x27;::text)")
  })

  it("shows only the clause a policy has", () => {
    const html = render({ ...UPDATE_POLICY, cmd: "SELECT", with_check: null })
    expect(html).toContain("USING")
    expect(html).not.toContain("WITH CHECK")
  })
})
