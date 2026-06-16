import type {
  BigInt,
  Color,
  DateOnly,
  Default,
  Email,
  FileAsset,
  Float,
  ImageAsset,
  Indexed,
  Int,
  JSON,
  LoggedIn,
  ManyToMany,
  Model,
  Optional,
  Owner,
  Public,
  RelatedTo,
  RichText,
  Role,
  Searchable,
  Slug,
  SmallInt,
  TSVector,
  Timestamp,
  UUID,
  Unique,
  URL,
  Vector,
  WithPublishable,
  WithSoftDelete,
  WithTimestamps,
} from "@supatype/types"
import type { avatars, postAttachments, postCovers } from "./buckets.js"

export type author = Model<WithTimestamps<{
  id: UUID
  email: Unique<Email>
  username: Unique<string>
  bio: Optional<RichText>
  avatarUrl: Optional<ImageAsset<avatars>>
  websiteUrl: Optional<URL>
  role: Default<"user" | "editor" | "admin", "user">
}>, {
  access: {
    read: Public
    create: Role<"service_role">
    update: LoggedIn
    delete: Role<"service_role">
  }
}>

export type userProfile = Model<WithSoftDelete<WithTimestamps<{
  id: UUID
  author: RelatedTo<author, { required: true; onDelete: "cascade" }>
  displayName: string
  followerCount: Default<Int, 0>
  followingCount: Default<Int, 0>
  reputationScore: Default<BigInt, 0>
  rank: Optional<SmallInt>
  birthDate: Optional<DateOnly>
  lastSeenAt: Optional<Timestamp>
}>>, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"author">
    delete: Role<"service_role">
  }
}>

export type category = Model<WithTimestamps<{
  id: UUID
  name: string
  slug: Unique<Slug<"name">>
  description: Optional<string>
  color: Default<Color, "#3b82f6">
  isActive: Default<boolean, true>
  externalId: Indexed<UUID>
}>, {
  access: {
    read: Public
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>

export type tag = Model<{
  id: UUID
  name: Unique<string>
  color: Optional<Color>
  posts: ManyToMany<post, { inverse: "tags" }>
}, {
  access: {
    read: Public
    create: LoggedIn
    update: LoggedIn
    delete: Role<"service_role">
  }
}>

export type post = Model<WithPublishable<WithTimestamps<{
  id: UUID
  title: string
  slug: Unique<Slug<"title">>
  excerpt: Optional<string>
  body: Optional<RichText>
  author: RelatedTo<author, { onDelete: "cascade" }>
  category: Optional<RelatedTo<category, { onDelete: "setNull" }>>
  tags: ManyToMany<tag, { inverse: "posts" }>
  coverImage: Optional<ImageAsset<postCovers>>
  attachment: Optional<FileAsset<postAttachments>>
  viewCount: Default<Int, 0>
  rating: Optional<Float>
  searchVector: Optional<Indexed<Searchable<TSVector>>>
  embedding: Optional<Vector<1536>>
  metadata: Optional<JSON<{ seo?: { metaTitle?: string; metaDesc?: string }; ogImage?: string }>>
}>>, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"author">
    delete: Owner<"author">
  }
}>

export type comment = Model<WithSoftDelete<WithTimestamps<{
  id: UUID
  body: string
  post: RelatedTo<post, { onDelete: "cascade" }>
  author: RelatedTo<author, { onDelete: "cascade" }>
  userId: RelatedTo<author, { onDelete: "cascade" }>
  upvotes: Default<Int, 0>
}>>, {
  access: {
    read: Public
    create: LoggedIn
    update: Owner<"author">
    delete: Owner<"author">
  }
}>
