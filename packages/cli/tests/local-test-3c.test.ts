import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BUCKET_MIME_TYPE, extractSchemaAstFromTypes } from "../src/type-extractor.js"

/** Local test round 3c: the smaller findings, each shown failing before its fix. */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-3c-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("a bucket's accept list", () => {
  function extract(accept: string): () => unknown {
    const schemaPath = join(dir, "schema.ts")
    writeFileSync(
      schemaPath,
      `import type { Model, UUID, ImageAsset, Bucket } from "@supatype/types"
export type pics = Bucket<"pics", { accept: [${accept}] }>
export type Post = Model<{ id: UUID; photo: ImageAsset<pics> }>
`,
      "utf8",
    )
    return () => extractSchemaAstFromTypes(schemaPath, dir)
  }

  // The engine took `accept: ["junk"]`, and only the storage service refused it, at provisioning.
  it("refuses a value that is not a MIME type, naming the bucket and the value", () => {
    expect(extract(`"image/png", "junk"`)).toThrow(/Bucket "pics": accept holds "junk", which is not a MIME type/)
  })

  it("takes type/subtype and type/*", () => {
    expect(extract(`"image/png", "image/*", "application/vnd.api+json"`)).not.toThrow()
  })

  // Two copies of one rule: the CLI must refuse exactly what the storage service would.
  it("is the storage service's rule", () => {
    const rules = readFileSync(join(import.meta.dirname, "..", "..", "storage", "src", "bucket-rules.ts"), "utf8")
    expect(rules).toContain(`const MIME_TYPE = ${String(BUCKET_MIME_TYPE)}`)
  })
})
