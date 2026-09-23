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
  Gte,
  Length,
  Literal,
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
  Searchable,
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
  /**
   * Shared across every reader, because the read rule does not mention one.
   *
   * `Lte<"published_at", Now>` varies by row and by the clock, never by who is asking, so a single
   * cached entry is correct for everybody. That is the case `public` exists to serve, and the one a
   * classifier that only asks "does this depend on identity?" refuses by mistake.
   */
  cache: { enabled: true, maxTtl: 300, public: true, rows: true }
  access: {
    read: Lte<"published_at", Now>
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>

export type Speaker = Model<{
  id: UUID
  /** `Searchable` alone is enough: Studio searches every column that carries it. */
  name: Searchable<string>
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
  cache: { enabled: true, maxTtl: 300, public: true, rows: true }
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
  /** Unconditionally readable and almost never edited: the easy end of the same argument. */
  cache: { enabled: true, maxTtl: 600, public: true, rows: true }
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
  title: NotLocalized<Searchable<string>>
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
  /** Named explicitly because the list view filters on the first entry, and title is the one. */
  searchable: ["title"]
  /**
   * The third way to refuse a value, and the only one that can name the field back to the caller.
   *
   * Bounds and constraints hold for every writer including `psql`; this runs on the API write path
   * only. It is here for a rule a `CHECK` genuinely cannot express — see the function itself.
   */
  validate: { title: "validate-talk-title" }
  indexes: [{ fields: ["day", "starts_at"] }]
  /**
   * The shortest ceiling here, because this is the model both front ends hammer.
   *
   * A ceiling, not a setting: Studio and the admin API may lower it or switch the table off, and
   * may never raise it past this line or cache a model that declared nothing. The schema stays an
   * honest description of what the system may do and an operator keeps a lever for an incident.
   */
  cache: { enabled: true, maxTtl: 120, public: true, rows: true }
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
  /**
   * Unique, because two sponsors with one name at one conference is a data error rather than a
   * possibility. It is also what lets the seed converge: without a unique key there is nothing for
   * `ON CONFLICT` to match, so every re-seed inserted another copy and the app rendered the same
   * sponsor three times at three different tiers.
   */
  name: Unique<string>
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
  cache: { enabled: true, maxTtl: 600, public: true, rows: true }
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
  /**
   * Cached per caller, and the one model here where `public` would be a data leak.
   *
   * `OwnerFrom<"authUser">` answers differently for every caller, so one shared entry would serve
   * one attendee's ticket to the next. `enabled` without `public` is the common case and the safe
   * one; asking for `public` here is refused at push, by name, because `access.read` is in this
   * same object and can be read at the same time as the declaration.
   */
  cache: { enabled: true, maxTtl: 30, public: false }
  access: {
    read: OwnerFrom<"authUser">
    create: LoggedIn
    update: OwnerFrom<"authUser">
    delete: OwnerFrom<"authUser">
  }
}>

/**
 * Lobby chat: what the realtime half of the app subscribes to, and where an attendee can meet all
 * three ways of refusing a value.
 *
 * The three deliberately live on a model a signed-in caller may write. Putting them on an
 * editor-only model would make them unreachable from the app, and a refusal nobody can trigger
 * teaches nothing about how the three differ.
 */
export type ChatMessage = Model<{
  id: UUID
  room: Indexed<string>
  /** A bound: compiled to a `CHECK`, so it holds for `psql` and seeds as much as for the API. */
  body: MaxLength<string, 500>
  authUser: RelatedTo<SupatypeAuthUser>
  authorName: Optional<string>
  created_at: Timestamp
}, {
  /**
   * A model constraint: also a `CHECK`, but one a field modifier cannot express, because it reads
   * the column rather than bounding its declaration.
   */
  constraints: [
    Gte<Length<"body">, Literal<2>>,
  ]
  /**
   * A validator: the only one of the three that can name the field back to the caller, and the
   * only one direct SQL bypasses. Here for a rule a `CHECK` cannot state.
   */
  validate: { body: "validate-chat-body" }
  /**
   * No `cache` block, on purpose, and the only model here that says so.
   *
   * This is the table the lobby subscribes to. A response cache in front of a feed whose whole
   * value is that it is current would serve a message list that is seconds stale while the socket
   * delivers the row that contradicts it, and the two would disagree on screen. The absence is the
   * declaration: a model with no `cache` block may not be cached by Studio, by the admin API or by
   * anyone, which is what makes leaving it out a decision rather than an oversight.
   *
   * `read: LoggedIn` would also rule out `public` on its own. A public entry is shared with every
   * caller including anonymous ones, and this table is not anon-readable.
   */
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
  cache: { enabled: true, maxTtl: 3600, public: true, rows: true }
  access: {
    read: Public
    create: Role<"editor">
    update: Role<"editor">
    delete: Role<"editor">
  }
}>
