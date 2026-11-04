import { describe, expectTypeOf, it } from "vitest"
import type { ModelMeta } from "../src/index.js"

type Hooks = NonNullable<ModelMeta<{ id: string }>["hooks"]>

describe("ModelMeta.hooks", () => {
  it("lets an after-hook ask for every column", () => {
    expectTypeOf<{ function: "notify"; columns: "all" }>().toExtend<NonNullable<Hooks["afterChange"]>>()
    expectTypeOf<{ function: "purge"; columns: "all" }>().toExtend<NonNullable<Hooks["afterDelete"]>>()
    expectTypeOf<{ function: "notify"; columns: "safe" }>().toExtend<NonNullable<Hooks["afterChange"]>>()
  })

  it("keeps columns off the before-hooks, which see the request rather than the stored row", () => {
    expectTypeOf<{ function: "moderate"; columns: "all" }>().not.toExtend<NonNullable<Hooks["beforeChange"]>>()
    expectTypeOf<{ function: "guard"; columns: "all" }>().not.toExtend<NonNullable<Hooks["beforeDelete"]>>()
  })

  it("accepts no other value for columns", () => {
    expectTypeOf<{ function: "notify"; columns: "every" }>().not.toExtend<NonNullable<Hooks["afterChange"]>>()
  })
})
