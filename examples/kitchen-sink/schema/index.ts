/**
 * The kitchen sink: one schema, two audiences.
 *
 * A conference. The marketing site sells it — pages, speakers, talks, sponsors, all published by an
 * editor and read by anyone. The app is what an attendee signed in to — their ticket, their
 * schedule, the lobby chat. The two halves want genuinely different features, which is why this
 * example has two front ends instead of one app rendered twice.
 *
 * Every type here earns its place. A `Kitchen` model with forty fields would cover the same
 * vocabulary and teach nobody when to reach for which, so the rule is: if a field cannot say why a
 * conference needs it, it does not belong.
 */
import type {
  Between,
  Block,
  Blocks,
  Bucket,
  BucketLoggedIn,
  BucketOwner,
  BucketPrivate,
  BucketPublic,
  BucketRole,
  Button,
  Color,
  ComputedFrom,
  Currency,
  DateOnly,
  Decimal,
  Duration,
  Email,
  FileAsset,
  GeoPoint,
  ImageAsset,
  Indexed,
  Int,
  JSON,
  LocaleConfig,
  Localized,
  LoggedIn,
  Lte,
  Markdown,
  MaxItems,
  MaxLength,
  Model,
  NotLocalized,
  Now,
  Optional,
  Owner,
  OwnerFrom,
  PhoneNumber,
  Public,
  RelatedTo,
  RichText,
  Role,
  Slug,
  SupatypeAuthUser,
  SupatypeAuthUserId,
  Timestamp,
  UUID,
  URL,
  Unique,
  Vector,
} from "@supatype/types"

/**
 * Two languages, because one makes per-locale publishing invisible.
 *
 * With a single locale, "publish English" and "publish" are the same button. With two, an
 * untranslated French abstract is *absent* from what a French reader gets rather than hidden from
 * them, and that difference is the feature.
 */
export type Locales = LocaleConfig<["en", "fr"], "en">

// ── Buckets ───────────────────────────────────────────────────────────────────────────────────
//
// Three access modes, because a conference genuinely has three kinds of file: a headshot anyone may
// see, a ticket only its holder may fetch, and sponsor artwork the sponsor team shares privately.

export type speakerHeadshots = Bucket<"speaker-headshots", {
  accessMode: "public"
  accept: ["image/png", "image/jpeg", "image/webp"]
  maxSize: "5MB"
  access: {
    read: BucketPublic
    create: BucketLoggedIn
    delete: BucketOwner
  }
}>

export type ticketFiles = Bucket<"ticket-files", {
  accessMode: "private"
  accept: ["application/pdf"]
  maxSize: "10MB"
  access: {
    read: BucketOwner
    create: BucketLoggedIn
    delete: BucketOwner
  }
}>

export type sponsorAssets = Bucket<"sponsor-assets", {
  accessMode: "custom"
  maxSize: "25MB"
  access: {
    read: BucketRole<"sponsor">
    create: BucketRole<"sponsor">
    delete: BucketPrivate
  }
}>

// ── Blocks ────────────────────────────────────────────────────────────────────────────────────
//
// A marketing page is not one rich-text column. An editor arranges sections, and the set of
// sections is a closed vocabulary rather than whatever HTML someone pastes.

export type HeroBlock = Block<"hero", {
  heading: Localized<string>
  subheading: Optional<Localized<string>>
  cta: Optional<Button>
}, { label: "Hero"; icon: "megaphone" }>

export type ProseBlock = Block<"prose", {
  body: Localized<RichText>
}, { label: "Prose"; icon: "text" }>

export type SpeakerGridBlock = Block<"speakerGrid", {
  heading: Optional<Localized<string>>
  limit: Between<Int, 3, 24>
}, { label: "Speaker grid"; icon: "users" }>

export type PageBlock = HeroBlock | ProseBlock | SpeakerGridBlock

// ── The marketing half ────────────────────────────────────────────────────────────────────────

/**
 * A marketing page, assembled from blocks and published per locale.
 *
 * `read` is the publishing rule itself rather than a `status` column every query has to remember:
 * an unpublished page is unreadable, not merely unselected. `versions` is what lets the live page
 * stay live while an editor works on the next one — a single row holds one copy of the content, so
 * without it, editing a published page either destroys what is live or withholds the edit.
 */
export type Page = Model<{
  id: UUID
  title: Localized<string>
  slug: Unique<Slug<"title">>
  /** Sharing copy, built from the title until someone types something better. */
  summary: Optional<MaxLength<ComputedFrom<string, "title">, 200>>
  body: MaxItems<Blocks<PageBlock>, 20>
  /** Set by `supatype.publish`, cleared by `unpublish`. Nothing else writes it. */
  published_at: Optional<Timestamp>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  versions: { drafts: true, keep: 20 }
  access: {
    read: Lte<"published_at", Now>
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>

export type Speaker = Model<{
  id: UUID
  name: string
  slug: Unique<Slug<"name">>
  /** Localized, so a French reader gets a French bio or none — never an English one in its place. */
  bio: Optional<Localized<RichText>>
  headshot: Optional<ImageAsset<speakerHeadshots>>
  /** Shape travels with the value; a link list is not worth a table. */
  links: Optional<JSON<{ label: string; href: string }[]>>
  email: Optional<Email>
  published_at: Optional<Timestamp>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  versions: true
  access: {
    read: Lte<"published_at", Now>
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>

export type Room = Model<{
  id: UUID
  name: string
  capacity: Between<Int, 10, 2000>
  /** Where in the venue, for the map on the schedule screen. */
  location: Optional<GeoPoint>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: Public
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>

/**
 * A talk, which both halves of the example want for different reasons: the marketing site lists it,
 * the app schedules it.
 *
 * `starts_at <= ends_at` is a model constraint rather than a validator, because it must hold for
 * `psql` and seeds too. A validator only guards the API write path.
 */
export type Talk = Model<{
  id: UUID
  title: NotLocalized<string>
  slug: Unique<Slug<"title">>
  abstract: Optional<Localized<RichText>>
  speaker: RelatedTo<Speaker>
  room: RelatedTo<Room>
  day: DateOnly
  starts_at: Indexed<Timestamp>
  ends_at: Timestamp
  /** Scheduled length, kept beside the timestamps so a mismatch is visible in Studio. */
  length: Duration
  /** Similarity, for "talks like this one". A column, not a service. */
  embedding: Optional<Vector<384>>
  published_at: Optional<Timestamp>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  versions: { drafts: true, keep: 10 }
  indexes: [{ fields: ["day", "starts_at"] }]
  constraints: [
    Lte<"starts_at", "ends_at">,
  ]
  access: {
    read: Lte<"published_at", Now>
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>

export type Sponsor = Model<{
  id: UUID
  name: string
  tier: "platinum" | "gold" | "community"
  /** Brand colour, so the plugin colour picker has somewhere honest to live. */
  brandColor: Optional<Color>
  logo: Optional<ImageAsset<sponsorAssets>>
  website: Optional<URL>
  /** Short blurb an editor writes in Markdown rather than a rich-text editor. */
  blurb: Optional<Localized<Markdown>>
  contactPhone: Optional<PhoneNumber>
  published_at: Optional<Timestamp>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: Lte<"published_at", Now>
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>

// ── The app half ──────────────────────────────────────────────────────────────────────────────

/** An attendee's profile row, keyed by their auth user. */
export type Attendee = Model<{
  id: SupatypeAuthUserId
  displayName: MaxLength<string, 80>
  avatar: Optional<ImageAsset<speakerHeadshots>>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: LoggedIn
    create: LoggedIn
    update: Owner<"id">
    delete: Owner<"id">
  }
}>

/**
 * A ticket: the row that proves per-row access is real.
 *
 * `read: OwnerFrom<"authUser">` is why the app can fetch "my ticket" with no filter and why nobody
 * else's is reachable even with a crafted query. The PDF lives in a private bucket for the same
 * reason.
 */
export type Ticket = Model<{
  id: UUID
  authUser: RelatedTo<SupatypeAuthUser>
  attendee: RelatedTo<Attendee>
  reference: Unique<string>
  price: Currency<"GBP">
  vatRate: Decimal<5, 2>
  pdf: Optional<FileAsset<ticketFiles>>
  created_at: Timestamp
  updated_at: Timestamp
}, {
  access: {
    read: OwnerFrom<"authUser">
    create: LoggedIn
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>

/** Lobby chat: what the realtime half of the app subscribes to. */
export type ChatMessage = Model<{
  id: UUID
  room: Indexed<string>
  body: MaxLength<string, 500>
  authUser: RelatedTo<SupatypeAuthUser>
  authorName: Optional<string>
  created_at: Timestamp
}, {
  access: {
    read: LoggedIn
    create: LoggedIn
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>

/** One row, edited in Studio: the conference's own details. */
export type SiteSettings = Model<{
  id: UUID
  conferenceName: string
  tagline: Optional<Localized<string>>
  venue: Optional<GeoPoint>
  supportEmail: Email
  created_at: Timestamp
  updated_at: Timestamp
}, {
  singleton: true
  access: {
    read: Public
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>
