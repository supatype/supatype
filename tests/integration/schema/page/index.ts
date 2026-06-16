import type {
  Blocks,
  JSON,
  LoggedIn,
  Model,
  Optional,
  Owner,
  Public,
  RelatedTo,
  Role,
  Slug,
  UUID,
  Unique,
  WithPublishable,
  WithTimestamps,
} from "@supatype/types"
import type { author } from "../blog.js"
import type { CalloutBlock, HeroBlock, ImageGalleryBlock, RichTextBlock } from "./blocks.js"

export type page = Model<WithPublishable<WithTimestamps<{
  id: UUID
  title: string
  slug: Unique<Slug<"title">>
  content: Optional<Blocks<HeroBlock | RichTextBlock | CalloutBlock | ImageGalleryBlock>>
  author: Optional<RelatedTo<author, { onDelete: "setNull" }>>
  metadata: Optional<JSON<{ seo?: { title?: string; description?: string }; noIndex?: boolean }>>
}>>, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"author">
    delete: Role<"service_role">
  }
}>

export type * from "./blocks.js"
