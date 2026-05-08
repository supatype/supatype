import type {
  BigInt,
  Blocks,
  Decimal,
  Default,
  FileAsset,
  Float,
  ImageAsset,
  Int,
  JSON,
  Model,
  Money,
  Optional,
  Public,
  Role,
  SmallInt,
  UUID,
  Unique,
  Vector,
  WithTimestamps,
} from "@supatype/types"
import type { productImages, productManuals } from "./buckets.js"
import type { CalloutBlock, HeroBlock, ImageGalleryBlock, RichTextBlock } from "./page/blocks.js"

export type product = Model<WithTimestamps<{
  id: UUID
  name: string
  sku: Unique<string>
  price: Decimal<10, 2>
  listPrice: Optional<Money>
  weight: Optional<Float>
  stock: Default<Int, 0>
  totalSold: Default<BigInt, 0>
  minOrder: Default<SmallInt, 1>
  status: Default<"active" | "inactive" | "discontinued", "active">
  featureTags: Optional<string[]>
  manualFile: Optional<FileAsset<productManuals>>
  primaryImage: ImageAsset<productImages>
  embedding: Optional<Vector<1536>>
  specs: Optional<JSON<Record<string, string | number | boolean>>>
  content: Optional<Blocks<HeroBlock | RichTextBlock | CalloutBlock | ImageGalleryBlock>>
}>, {
  access: {
    read: Public
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>
