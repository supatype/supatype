import { describe, expectTypeOf, it } from "vitest"
import type {
  All,
  AuthUid,
  BucketLoggedIn,
  BucketOwner,
  BucketPublic,
  BucketStorageAccess,
  Claim,
  Eq,
  Folder,
  Literal,
} from "../src/index.js"

describe("BucketStorageAccess", () => {
  it("has the four operations a model has, update included", () => {
    expectTypeOf<BucketStorageAccess>().toHaveProperty("read")
    expectTypeOf<BucketStorageAccess>().toHaveProperty("create")
    expectTypeOf<BucketStorageAccess>().toHaveProperty("update")
    expectTypeOf<BucketStorageAccess>().toHaveProperty("delete")
  })

  it("accepts a fully declared bucket", () => {
    expectTypeOf<{
      read: BucketPublic
      create: BucketLoggedIn
      update: BucketOwner
      delete: BucketOwner
    }>().toExtend<BucketStorageAccess>()
  })
})

describe("bucket rules that name the caller and the path", () => {
  it("accepts a per-user folder rule", () => {
    expectTypeOf<{
      create: Eq<Folder<1>, AuthUid>
      update: Eq<Folder<1>, AuthUid>
    }>().toExtend<BucketStorageAccess>()
  })

  it("accepts a registered-only rule built from a claim", () => {
    expectTypeOf<{
      create: All<[BucketLoggedIn, Eq<Claim<"is_anonymous">, Literal<false>>]>
    }>().toExtend<BucketStorageAccess>()
  })

  it("takes a number as the folder position", () => {
    // @ts-expect-error a folder position is a number
    type Bad = Folder<"1">
    expectTypeOf<Folder<2>>().not.toEqualTypeOf<Folder<1>>()
  })
})
