/**
 * `StorageObject` and `RemovedObject` are what the storage service sends, field for field.
 *
 * `StorageObject` used to declare `owner` and `metadata` optional, which the service sends as null,
 * and left out the `size` and `mimetype` every list entry carries. `remove()` claimed to answer with
 * whole objects when the service sends only each one's name and bucket, so `data[0].id` typechecked
 * and was undefined. And the runtime check read only `name`, so a body of the wrong shape went
 * through as if it were a list.
 *
 * `LISTED` is a real entry, captured from packages/storage's `list` route by the caller-rules suite,
 * which also pins the service's side of this to the same fields.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { StorageClient } from "../src/storage.js"
import type { RemovedObject, StorageObject } from "../src/index.js"
import { fetchReturning } from "./support/fetch-mock.js"
import { LISTED, UNOWNED } from "./support/storage-object.js"
import { readFileSync } from "node:fs"
import { isArrayOf, isJsonObject, isShape, isString } from "../src/json.js"

/** packages/storage's list-entry contract, which supatype-server's local objstore also checks. */
const CONTRACT = new URL("../../storage/tests/fixtures/list-entry.json", import.meta.url)

const bucket = (): ReturnType<StorageClient["from"]> =>
  new StorageClient("http://storage.test", () => Promise.resolve({})).from("avatars")

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("StorageObject", () => {
  it("declares exactly the fields a list entry carries", () => {
    expectTypeOf<StorageObject>().toEqualTypeOf<{
      id: string
      bucket_id: string
      name: string
      owner: string | null
      metadata: Record<string, unknown> | null
      created_at: string
      updated_at: string
      last_accessed_at: string
      size: number | null
      mimetype: string | null
    }>()
    expectTypeOf(LISTED).toExtend<StorageObject>()
  })

  it("reads a real list answer", async () => {
    vi.stubGlobal("fetch", fetchReturning([LISTED, UNOWNED]))
    const { data, error } = await bucket().list()
    expect(error).toBeNull()
    expect(data).toEqual([LISTED, UNOWNED])
  })

  it("refuses a list answer that is not a list of objects", async () => {
    vi.stubGlobal("fetch", fetchReturning([{ name: "a.txt", bucket_id: "avatars" }]))
    await expect(bucket().list()).rejects.toThrow(/Unexpected response/)
  })

  // The contract every storage server is checked against: if it changes, this type must follow.
  it("is the storage servers' list-entry contract", () => {
    const contract: unknown = JSON.parse(readFileSync(CONTRACT, "utf8"))
    const isContract = isShape({ entry: isJsonObject, nullable: isArrayOf(isString) })
    if (!isContract(contract)) throw new Error("list-entry.json is not { entry, nullable }")
    expect(contract.entry).toEqual(LISTED)
    expect([...contract.nullable].sort()).toEqual(["metadata", "mimetype", "owner", "size"])
  })
})

describe("RemovedObject", () => {
  it("is what remove() answers: each removed object's name and bucket", async () => {
    expectTypeOf<RemovedObject>().toEqualTypeOf<{ name: string; bucket_id: string }>()
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof bucket>["remove"]>>["data"]>().toEqualTypeOf<RemovedObject[] | null>()
    vi.stubGlobal("fetch", fetchReturning([{ name: "a.txt", bucket_id: "avatars" }]))
    const { data } = await bucket().remove(["a.txt"])
    expect(data).toEqual([{ name: "a.txt", bucket_id: "avatars" }])
  })
})
