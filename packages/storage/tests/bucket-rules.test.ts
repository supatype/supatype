import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bucketIdProblem, bucketSettingsProblem } from "../src/bucket-rules.js"
import { isArrayOf, isShape, isString } from "../src/json.js"

/**
 * Local test round 3b: the storage service accepted bucket ids `a/b`, `.supatype` and a
 * 300-character id, a negative size limit, junk MIME types and a junk policy, and answered 500 for a
 * size limit out of range. The server's store refuses an id that cannot be a directory of its own
 * (a separator, `.` or `..`) and its own `.supatype`, so the service refuses the same with 400,
 * and refuses settings it cannot honour.
 */
/** The id table this service and the server's store share (fixtures/bucket-ids.json). */
const isIdCase = isShape({ id: isString, why: isString })
const isIdTable = isShape({ accepted: isArrayOf(isString), refused: isArrayOf(isIdCase), refused_by_service: isArrayOf(isIdCase) })
const parsedIds: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "bucket-ids.json"), "utf8"))
if (!isIdTable(parsedIds)) throw new Error("fixtures/bucket-ids.json does not hold the id table")
const ids = parsedIds

describe("bucket ids", () => {
  it.each(ids.accepted)("accepts %s", (id) => {
    expect(bucketIdProblem(id)).toBeNull()
  })

  it.each([...ids.refused, ...ids.refused_by_service])("refuses $why", ({ id }) => {
    expect(bucketIdProblem(id)).toMatch(/invalid bucket id/)
  })
})

describe("bucket settings", () => {
  it("accepts a size limit, MIME types with wildcards and a JSON policy, and their absence", () => {
    expect(bucketSettingsProblem({ file_size_limit: 1024, allowed_mime_types: ["image/png", "image/*", "application/vnd.api+json"], s3_bucket_policy: '{"Version":"2012-10-17"}' })).toBeNull()
    expect(bucketSettingsProblem({ file_size_limit: null, allowed_mime_types: null, s3_bucket_policy: null })).toBeNull()
    expect(bucketSettingsProblem({})).toBeNull()
  })

  it.each([
    ["a negative size limit", { file_size_limit: -1 }],
    ["a fractional size limit", { file_size_limit: 1.5 }],
    ["a size limit out of range", { file_size_limit: 1e20 }],
    ["a MIME type that is not type/subtype", { allowed_mime_types: ["not a type"] }],
    ["an empty MIME type", { allowed_mime_types: [""] }],
    ["a policy that is not a JSON object", { s3_bucket_policy: "allow everyone" }],
  ])("refuses %s", (_why, settings) => {
    expect(bucketSettingsProblem(settings)).not.toBeNull()
  })
})
