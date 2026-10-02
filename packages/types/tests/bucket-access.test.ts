import { describe, expectTypeOf, it } from "vitest"
import type { BucketLoggedIn, BucketOwner, BucketPublic, BucketStorageAccess } from "../src/index.js"

describe("BucketStorageAccess", () => {
  it("has the four operations a model has, update included", () => {
    expectTypeOf<BucketStorageAccess>().toHaveProperty("read")
    expectTypeOf<BucketStorageAccess>().toHaveProperty("create")
    expectTypeOf<BucketStorageAccess>().toHaveProperty("update")
    expectTypeOf<BucketStorageAccess>().toHaveProperty("delete")
  })

  it("accepts a fully declared bucket", () => {
    const crud = {} as {
      read: BucketPublic
      create: BucketLoggedIn
      update: BucketOwner
      delete: BucketOwner
    }
    expectTypeOf(crud).toExtend<BucketStorageAccess>()
  })
})
