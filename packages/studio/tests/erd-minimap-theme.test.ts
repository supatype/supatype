import { describe, expect, it } from "vitest"
import { ERD_MINIMAP } from "../src/lib/erd-minimap.js"

/**
 * S-17: the ERD's minimap drew a white box in dark mode. React Flow paints the minimap's own
 * background white unless told otherwise, and only its mask followed the theme.
 */
describe("the ERD minimap", () => {
  it("takes every colour from the theme, its background included", () => {
    for (const colour of Object.values(ERD_MINIMAP)) expect(colour).toMatch(/^hsl\(var\(--[a-z-]+\)/)
    expect(ERD_MINIMAP.bgColor).toBeDefined()
  })
})
