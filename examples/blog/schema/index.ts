import type {
  BucketLoggedIn,
  BucketOwner,
  BucketPublic,
  Bucket,
  ComputedFrom,
  FileAsset,
  ImageAsset,
  LoggedIn,
  MaxLength,
  Model,
  Optional,
  Owner,
  OwnerFrom,
  Public,
  RelatedTo,
  RichText,
  Slug,
  SupatypeAuthUser,
  SupatypeAuthUserId,
  Timestamp,
  UUID,
  Unique
} from "@supatype/types"

export type userAvatars = Bucket<"user-avatars", {
  accessMode: "public"
  accept: ["image/png", "image/jpeg", "image/webp"]
  maxSize: "5MB"
  access: {
    read: BucketPublic
    create: BucketLoggedIn
    delete: BucketOwner
  }
}>

export type postCovers = Bucket<"post-covers", {
  accessMode: "public"
  accept: ["image/png", "image/jpeg", "image/webp"]
  maxSize: "10MB"
  access: {
    read: BucketPublic
    create: BucketLoggedIn
    delete: BucketOwner
  }
}>

export type postAttachments = Bucket<"post-attachments", {
  accessMode: "private"
  maxSize: "50MB"
  access: {
    read: BucketLoggedIn
    create: BucketLoggedIn
    delete: BucketOwner
  }
}>

export type User = Model<{
  id: SupatypeAuthUserId
  name: string
  avatarUrl: Optional<ImageAsset<userAvatars>>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: LoggedIn
    create: LoggedIn
    update: Owner<"id">
    delete: Owner<User, "id">
  }
}>

/**
 * Derived vs server-only vs audit:
 * - `ComputedFrom` — Studio **derivedText** preview tracks sources like {@link Slug}; regenerate admin after schema changes.
 * - `Computed` — server/DB only, **no** Studio preview wiring (read-only in the editor).
 * - `created_at` / `updated_at` — by **column name**, extractor adds `DEFAULT NOW()` + Studio prefill (`Timestamp` columns); optional `Timestamps` mixin matches that pair.
 *
 * Templates: `{field}`, `{truncate(field, n)}`, `\n` in the string literal for newlines.
 */
export type Post = Model<{
  id: UUID
  title: string
  slug: Optional<Unique<Slug<"title">>>
  /** Single-line listing blurb: mirrors `title` until you type something else on create. */
  teaser: Optional<ComputedFrom<string, "title">>
  /** Card / SEO text: built from title + lexical plain text from `body` until you edit on create. */
  excerpt: Optional<MaxLength<ComputedFrom<string, readonly ["title", "body"]>, 320>>
  /** Sharing line: illustrates `{field}`, `{truncate(…)}`, and `\n` in the format string. */
  feedCaption: Optional<ComputedFrom<string, "Post: {title} | {published_at}\n{truncate(body, 80)}">>
  body: RichText
  coverImage: Optional<ImageAsset<postCovers>>
  attachment: Optional<FileAsset<postAttachments>>
  authUser: RelatedTo<SupatypeAuthUser>
  authorProfile: RelatedTo<User>
  status: "draft" | "published" | "scheduled" | "archived"
  published_at: Optional<string>
  scheduled_at: Optional<string>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: Public
    create: LoggedIn
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>

export type Comment = Model<{
  id: UUID
  authUser: RelatedTo<SupatypeAuthUser>
  authorProfile: RelatedTo<User>
  body: string
  post: RelatedTo<Post>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: Public
    create: LoggedIn
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>
