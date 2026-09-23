import type {
  BucketLoggedIn,
  BucketOwner,
  BucketPublic,
  Bucket,
  ComputedFrom,
  FileAsset,
  ImageAsset,
  LoggedIn,
  Localized,
  LocaleConfig,
  Lte,
  MaxLength,
  Model,
  Now,
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


/**
 * The languages this blog publishes in.
 *
 * Two is enough to make per-locale publishing real: with one, "publish English" and "publish" are
 * the same button and the feature looks like decoration.
 */
export type Locales = LocaleConfig<["en", "fr"], "en">
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
 * - `ComputedFrom`: Studio **derivedText** preview tracks sources like {@link Slug}; regenerate admin after schema changes.
 * - `Computed`: server/DB only, **no** Studio preview wiring (read-only in the editor).
 * - `created_at` / `updated_at`: by **column name**, extractor adds `DEFAULT NOW()` + Studio prefill (`Timestamp` columns); optional `Timestamps` mixin matches that pair.
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
  /**
   * Localized, so the example demonstrates publishing one language before another.
   *
   * The column holds every locale at once. Publishing `en` writes the English key into the live row
   * and leaves the French exactly as it was, so an untranslated or unapproved language is *absent*
   * from what readers get rather than hidden from them.
   */
  body: Localized<RichText>
  coverImage: Optional<ImageAsset<postCovers>>
  attachment: Optional<FileAsset<postAttachments>>
  authUser: RelatedTo<SupatypeAuthUser>
  authorProfile: RelatedTo<User>
  /** Set by `supatype.publish`, cleared by `unpublish`. Nothing else writes it. */
  published_at: Optional<Timestamp>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  /**
   * Drafts, history and publishing.
   *
   * This model used to carry `status: "draft" | "published" | "scheduled" | "archived"` and a
   * `scheduled_at` column, which is the shape `versions` replaces. A single row holds one copy of
   * the content, so editing a published post either destroyed what was live or withheld the edit:
   * there was nowhere for "published" and "next" to both exist. Now the row *is* what is published
   * and the pending edit lives in `post_versions`.
   */
  versions: { drafts: true, keep: 20 }
  access: {
    /**
     * Only published posts, and the rule is the whole filter.
     *
     * The app used to say `.eq("status", "published")` on every query, which is a filter an author
     * has to remember on each one. The unpublished row is now unreadable rather than merely
     * unselected.
     */
    read: Lte<"published_at", Now>
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
