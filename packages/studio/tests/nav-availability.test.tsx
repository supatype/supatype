import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { TertiaryNav } from "../src/components/TertiaryNav.js"

/**
 * Studio's navigation used to offer 29 destinations that do nothing: 28 "coming soon" placeholders
 * and one view whose own body reads "not yet available for this project". Fourteen of the 37
 * sub-nav entries led to one, and every log tab but one was a placeholder.
 *
 * A tab that cannot be opened is not removed, deliberately. Somebody hunting for Postgres logs
 * should learn that this build has none, not conclude the product has none — and for the features
 * that live on Cloud, the entry is how they find out where it lives.
 *
 * So the rule is: it is there, it cannot be clicked, and it says which of the two it is. These pin
 * that, and pin that a tab which *does* work is not swept up with them.
 */
function nav(path: string): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(TertiaryNav),
    ),
  )
}

describe("log tabs that cannot be opened", () => {
  const html = (): string => nav("/observability/logs/api")

  it("still lists every tab, so nothing looks absent from the product", () => {
    for (const label of ["API", "Auth", "Storage", "Edge Functions", "Realtime", "Postgres"]) {
      expect(html()).toContain(label)
    }
  })

  it("marks the unbuilt ones disabled rather than dropping them", () => {
    // `aria-disabled` is what tells a screen reader the control is inert; the muted styling only
    // tells somebody looking at it.
    const rendered = html()
    expect((rendered.match(/aria-disabled="true"/g) ?? []).length).toBe(5)
  })

  it("says why, in words, on each one", () => {
    // A greyed-out tab with no explanation is worse than a missing one: it looks broken rather
    // than unbuilt.
    for (const note of [
      "Request logging is not built yet",
      "Auth event logging is not built yet",
      "Storage access logging is not built yet",
      "Realtime connection logging is not built yet",
      "Database server logs are not built yet",
    ]) {
      expect(html()).toContain(note)
    }
  })

  it("leaves the tab that works clickable", () => {
    // Function logs shipped. This tab said "coming in Phase 30" until it did, and the failure worth
    // catching now is the opposite one: a working feature swept up with the placeholders.
    const rendered = html()
    const at = rendered.indexOf("Edge Functions")
    expect(at).toBeGreaterThan(-1)
    // The element holding it must be a button, not the disabled span the others render as.
    const opensAt = rendered.lastIndexOf("<", at)
    expect(rendered.slice(opensAt, at)).toContain("button")
  })
})
