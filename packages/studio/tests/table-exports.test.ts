import { describe, expect, it } from "vitest"
import * as studio from "../src/index.js"

/**
 * The table primitives Studio's own views are built from are part of the package's surface, so a
 * host app (Supatype Cloud's Studio) draws its tables from them instead of its own markup.
 */
describe("the package's table primitives", () => {
  it.each(["Table", "TableCard", "Th", "Td", "tableRowClass"])("exports %s", (name) => {
    expect(typeof Reflect.get(studio, name)).toBe("function")
  })
})
