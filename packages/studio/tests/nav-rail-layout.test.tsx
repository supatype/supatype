import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { TertiaryNav } from "../src/components/TertiaryNav.js"
import { NAV_RAIL } from "../src/components/ui.js"

/**
 * The two rails that meet at the secondary panel's right edge.
 *
 * Tier 2's header and tier 3's tab bar start at the same y and sit side by side, so their bottom
 * borders are read as one line across the app. They were built separately and did not match: the
 * tab bar was exactly `h-10`, the panel header was padding-derived (`pt-4 pb-2.5`, about 42px),
 * and the borders were drawn at different opacities. The line stepped down and changed colour
 * halfway across.
 *
 * Nothing about either component looks wrong on its own, which is why this is pinned on the shared
 * constant rather than on a pixel value: the failure mode is one of the two being adjusted alone.
 *
 * Below `md` the panel is an overlay rather than docked chrome. A 200px panel beside a content
 * column left roughly 190px for the content on a 390px phone, narrower than the headings inside
 * it, so "Job Post: Cache" wrapped onto three lines. The toggle that opens it lives in the tier-3
 * rail, which means that rail has to exist even on routes with no tabs.
 */

function nav(path: string, leading?: React.ReactNode): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(TertiaryNav, leading === undefined ? {} : { leading }),
    ),
  )
}

const TOGGLE = React.createElement("button", { "data-testid": "panel-toggle" }, "Menu")

describe("the shared nav rail", () => {
  it("is one constant, so the two rails cannot be sized apart", () => {
    // Height and border in one place. If this splits, the rails drift.
    expect(NAV_RAIL).toContain("h-10")
    expect(NAV_RAIL).toContain("border-b")
    expect(NAV_RAIL).toContain("border-border/80")
  })

  it("is what the tertiary nav's own element carries", () => {
    // The <nav> element itself, not merely somewhere in the markup: the height used to live on an
    // inner div, which a whole-string search cannot tell apart from the rail carrying it.
    const railClass = /<nav class="([^"]*)"/.exec(nav("/models/job_post"))?.[1] ?? ""
    for (const cls of NAV_RAIL.split(" ")) {
      expect(railClass.split(" ")).toContain(cls)
    }
  })

  it("does not reintroduce a fixed height inside the rail", () => {
    // The inner row used to restate `h-10`; it now fills the rail, so there is one height.
    expect(nav("/models/job_post")).toContain("h-full")
  })
})

describe("the section panel toggle", () => {
  it("rides in the tab rail when the route has tabs", () => {
    const html = nav("/models/job_post", TOGGLE)
    expect(html).toContain("panel-toggle")
    expect(html).toContain("Cache")
  })

  it("still renders on a route with no tabs, or a phone cannot reopen the panel", () => {
    // /settings has no tertiary group. Before, the whole rail returned null here.
    const html = nav("/settings", TOGGLE)
    expect(html).toContain("panel-toggle")
  })

  it("is the only thing on that bare rail, and the rail is mobile-only", () => {
    const html = nav("/settings", TOGGLE)
    expect(html).toContain("md:hidden")
  })

  it("leaves the rail absent entirely when there is no toggle and no tabs", () => {
    expect(nav("/settings")).toBe("")
  })
})
