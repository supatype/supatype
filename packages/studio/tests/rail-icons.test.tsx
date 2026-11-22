import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Icon, hasIcon } from "../src/components/icons.js"
import { railIconNames } from "../src/components/Sidebar.js"

// S-2: two rail entries drew the same icon (Static site and Custom Domains, Settings and Project
// Settings). Every entry now has a drawing of its own, from the one shared icon set.

function drawing(name: string): string {
  return renderToStaticMarkup(<Icon name={name} />)
}

describe("the rail's icons", () => {
  it("are all in the shared icon set", () => {
    for (const name of railIconNames()) expect(hasIcon(name), name).toBe(true)
  })

  it("never draw the same thing for two entries", () => {
    const drawings = railIconNames().map(drawing)
    expect(new Set(drawings).size).toBe(drawings.length)
  })
})

describe("the icons a host's pages are given", () => {
  // Cloud's Custom Domains keeps the globe and its Project Settings is a pair with the core Settings
  // entry, so neither may be the drawing a core rail entry already has.
  it.each([
    ["sliders", "a project's settings page, apart from the core Settings cog"],
    ["layout", "the Static site group, apart from the globe a domains page uses"],
  ])("includes %s, %s", (name) => {
    expect(hasIcon(name)).toBe(true)
    expect(drawing(name)).not.toBe(drawing("globe"))
    expect(drawing(name)).not.toBe(drawing("settings"))
  })

  it("keeps the globe off the core rail so a domains page can have it", () => {
    expect(railIconNames()).not.toContain("globe")
  })
})
