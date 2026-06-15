import { describe, expectTypeOf, it } from "vitest"
import type {
  Bucket,
  FileAsset,
  ImageAsset,
  Localized,
  LocalizedModel,
  Model,
  NotLocalized,
  Optional,
  SpreadOptionalModelFields,
  UUID,
} from "../src/index.js"

type Covers = Bucket<"post-covers", Record<string, unknown>>
type AttachmentBucket = Bucket<"attachments", Record<string, unknown>>

describe("SpreadOptionalModelFields", () => {
  it("makes Optional<ImageAsset<bucket>> optional (modifiers stack on primitives)", () => {
    type Fields = {
      id: UUID
      coverImage: Optional<ImageAsset<Covers>>
    }
    type Row = SpreadOptionalModelFields<Fields>

    expectTypeOf<Row>().toMatchTypeOf<{ id: UUID; coverImage?: ImageAsset<Covers> | null }>()
  })

  it("Model<> row omits Optional ImageAsset columns", () => {
    type M = Model<{
      id: UUID
      coverImage: Optional<ImageAsset<Covers>>
    }>

    const row: M = {
      id: "" as UUID,
    }
    expectTypeOf(row).toMatchTypeOf<M>()
  })

  it("optional attachment FileAsset resolves to omitted keys on literals", () => {
    type Row = SpreadOptionalModelFields<{
      attachment: Optional<FileAsset<AttachmentBucket>>
    }>
    const _: Row = {}
    expectTypeOf(_.attachment).toEqualTypeOf<FileAsset<AttachmentBucket> | null | undefined>()
  })

  it("unwraps Localized fields to locale-keyed records", () => {
    type Row = SpreadOptionalModelFields<{
      title: Localized<string>
      subtitle: Optional<Localized<string>>
    }>

    expectTypeOf<Row>().toMatchTypeOf<{
      title: Record<string, string>
      subtitle?: Record<string, string> | null
    }>()
  })

  it("LocalizedModel infers localized copy fields", () => {
    type Row = LocalizedModel<{
      hero_title: string
      map_url: NotLocalized<string>
    }>

    expectTypeOf<Row>().toMatchTypeOf<{
      hero_title: Record<string, string>
      map_url: string
    }>()
  })
})
