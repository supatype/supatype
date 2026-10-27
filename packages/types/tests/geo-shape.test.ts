import { describe, expectTypeOf, it } from "vitest"
import type { Geo } from "../src/index.js"

describe("Geo", () => {
  it("is a point unless a shape is given", () => {
    expectTypeOf<Geo>().toEqualTypeOf<Geo<"point">>()
  })

  it("carries the shape it was given", () => {
    expectTypeOf<Geo<"polygon">["type"]>().toEqualTypeOf<"polygon">()
  })
})
