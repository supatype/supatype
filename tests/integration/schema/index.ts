import { model, field, bucket, relation, access, supatype, block, composites, locale } from "@supatype/schema"

// ── Buckets ─────────────────────────────────────────────────────────────────
// Exported so the CLI picks them up and creates them during deploy,
// even if no field references a bucket yet.

export const heroImages      = bucket("hero-images",      { accessMode: "public" })
export const avatars         = bucket("avatars",          { accessMode: "public" })
export const postCovers      = bucket("post-covers",      { accessMode: "public" })
export const postAttachments = bucket("post-attachments", { accessMode: "private", maxSize: "50MB" })
export const productManuals  = bucket("product-manuals",  { accessMode: "private", accept: ["application/pdf"] })
export const productImages   = bucket("products",         { accessMode: "public" })

export const localeConfig = locale({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
})

// ── Block types ────────────────────────────────────────────────────────────────

const HeroBlock = block("hero", {
  icon: "layout",
  label: "Hero Section",
  fields: {
    heading:         field.text({ required: true }),
    subheading:      field.text(),
    backgroundImage: field.image({ bucket: heroImages }),
    ctaLabel:        field.text(),
    ctaUrl:          field.url(),
  },
})

const RichTextBlock = block("rich_text", {
  icon: "align-left",
  label: "Rich Text",
  fields: {
    content: field.richText({ required: true }),
  },
})

const CalloutBlock = block("callout", {
  icon: "alert-circle",
  label: "Callout",
  fields: {
    level:   field.enum(["info", "warning", "error", "success"], { required: true }),
    message: field.text({ required: true }),
    icon:    field.text(),
  },
})

const ImageGalleryBlock = block("image_gallery", {
  icon: "image",
  label: "Image Gallery",
  fields: {
    caption:    field.text(),
    columns:    field.smallInt({ default: { kind: "value", value: 3 } }),
    showCaptions: field.boolean({ default: { kind: "value", value: false } }),
  },
})

// ── Authors ────────────────────────────────────────────────────────────────────
// Covers: email, url, enum (with string values), image (with accessMode)

export const author = model("author", {
  fields: {
    email:      field.email({ required: true, unique: true }),
    username:   field.text({ required: true, unique: true }),
    bio:        field.richText(),
    avatarUrl:  field.image({ bucket: avatars }),
    websiteUrl: field.url(),
    role:       field.enum(["user", "editor", "admin"], { default: "user" }),
  },
  access: {
    read:   access.any(),
    create: access.role("service_role"),
    update: access.role("authenticated"),
    delete: access.role("service_role"),
  },
  options: { timestamps: true },
})

// ── User Profile ───────────────────────────────────────────────────────────────
// Covers: integer, bigInt, smallInt, date, timestamp, softDelete composite

export const userProfile = model("user_profile", {
  fields: {
    author:         relation.belongsTo("author", { required: true, onDelete: "cascade" }),
    displayName:    field.text({ required: true }),
    followerCount:  field.integer({ default: { kind: "value", value: 0 } }),
    followingCount: field.integer({ default: { kind: "value", value: 0 } }),
    reputationScore:field.bigInt({ default: { kind: "value", value: 0 } }),
    rank:           field.smallInt(),
    birthDate:      field.date(),
    lastSeenAt:     field.timestamp(),
    deletedAt:      composites.softDelete(),
    timestamps:     composites.timestamps(),
  },
  access: {
    read:   access.any(),
    create: access.role("authenticated"),
    update: access.owner("author"),
    delete: access.role("service_role"),
  },
})

// ── Categories ─────────────────────────────────────────────────────────────────
// Covers: slug, uuid, boolean, index

export const category = model("category", {
  fields: {
    name:       field.text({ required: true }),
    slug:       field.slug({ from: "name", unique: true }),
    description:field.text(),
    color:      field.color({ default: { kind: "value", value: "#3b82f6" } }),
    isActive:   field.boolean({ default: { kind: "value", value: true } }),
    externalId: field.uuid({ index: true }),
  },
  access: {
    read:   access.any(),
    create: access.role("service_role"),
    update: access.role("service_role"),
    delete: access.role("service_role"),
  },
  options: { timestamps: true },
})

// ── Tags ───────────────────────────────────────────────────────────────────────

export const tag = model("tag", {
  fields: {
    name:  field.text({ required: true, unique: true }),
    color: field.color(),
  },
  access: {
    read:   access.any(),
    create: access.role("authenticated"),
    update: access.role("authenticated"),
    delete: access.role("service_role"),
  },
})

// ── Posts ──────────────────────────────────────────────────────────────────────
// Covers: slug, tsvector (FTS index), vector (embeddings), float, manyToMany,
//         file, json, publishable composite

export const post = model("post", {
  fields: {
    title:        field.text({ required: true }),
    slug:         field.slug({ from: "title", unique: true }),
    excerpt:      field.text(),
    body:         field.richText(),
    author:       relation.belongsTo(supatype.user, { onDelete: "cascade" }),
    category:     relation.belongsTo("category", { onDelete: "setNull" }),
    tags:         relation.manyToMany("tag"),
    coverImage:   field.image({ bucket: postCovers }),
    attachment:   field.file({ bucket: postAttachments }),
    viewCount:    field.integer({ default: { kind: "value", value: 0 } }),
    rating:       field.float(),
    searchVector: field.tsvector({ index: true }),
    embedding:    field.vector({ dimensions: 1536 }),
    publishState: composites.publishable(),
    metadata:     field.json<{ seo?: { metaTitle?: string; metaDesc?: string }; ogImage?: string }>(),
  },
  access: {
    read:   access.any(),
    create: access.role("authenticated"),
    update: access.owner("author"),
    delete: access.owner("author"),
  },
  options: { timestamps: true },
})

// ── Comments ───────────────────────────────────────────────────────────────────
// Covers: softDelete (options-level), integer (vote count), hasMany from post

export const comment = model("comment", {
  fields: {
    body:     field.text({ required: true }),
    post:     relation.belongsTo("post", { onDelete: "cascade" }),
    author:   relation.belongsTo("author", { onDelete: "cascade" }),
    userId:   relation.belongsTo(supatype.user, { onDelete: "cascade" }),
    upvotes:  field.integer({ default: { kind: "value", value: 0 } }),
  },
  access: {
    read:   access.any(),
    create: access.role("authenticated"),
    update: access.owner("author"),
    delete: access.owner("author"),
  },
  options: { timestamps: true, softDelete: true },
})

// ── Products ───────────────────────────────────────────────────────────────────
// Covers: decimal, money, float, bigInt, smallInt, arrayOf, enum,
//         vector, blocks, file, json

export const product = model("product", {
  fields: {
    name:         field.text({ required: true }),
    sku:          field.text({ required: true, unique: true }),
    price:        field.decimal({ required: true, precision: 10, scale: 2 }),
    listPrice:    field.money({ localized: true }),
    weight:       field.float(),
    stock:        field.integer({ required: true, default: { kind: "value", value: 0 } }),
    totalSold:    field.bigInt({ default: { kind: "value", value: 0 } }),
    minOrder:     field.smallInt({ default: { kind: "value", value: 1 } }),
    status:       field.enum(["active", "inactive", "discontinued"], {
      required: true,
      default: "active",
    }),
    featureTags:  field.arrayOf("text"),
    manualFile:   field.file({ bucket: productManuals }),
    primaryImage: field.image({ bucket: productImages, required: true }),
    embedding:    field.vector({ dimensions: 1536 }),
    specs:        field.json<Record<string, string | number | boolean>>(),
    content:      field.blocks([HeroBlock, RichTextBlock, CalloutBlock, ImageGalleryBlock]),
    timestamps:   composites.timestamps(),
  },
  access: {
    read:   access.any(),
    create: access.role("service_role"),
    update: access.role("service_role"),
    delete: access.role("service_role"),
  },
})

// ── Events ─────────────────────────────────────────────────────────────────────
// Covers: date, timestamp, datetime, interval, geo (point + polygon)

export const event = model("event", {
  fields: {
    title:        field.text({ required: true }),
    description:  field.richText(),
    startsAt:     field.datetime({ required: true }),
    endsAt:       field.datetime(),
    eventDate:    field.date(),
    createdTs:    field.timestamp(),
    duration:     field.interval(),
    location:     field.geo({ type: "point", srid: 4326 }),
    coverageArea: field.geo({ type: "polygon" }),
    route:        field.geo({ type: "linestring" }),
    organizer:    relation.belongsTo("author", { onDelete: "setNull" }),
    maxAttendees: field.integer(),
    isPublic:     field.boolean({ default: { kind: "value", value: true } }),
    timestamps:   composites.timestamps(),
  },
  access: {
    read:   access.any(),
    create: access.role("authenticated"),
    update: access.owner("organizer"),
    delete: access.role("service_role"),
  },
})

// ── Network Logs ───────────────────────────────────────────────────────────────
// Covers: ip, cidr, macaddr, bytea, xml, tsquery, tsvector (standalone), smallInt

export const networkLog = model("network_log", {
  fields: {
    sourceIp:     field.ip({ required: true }),
    subnet:       field.cidr(),
    deviceMac:    field.macaddr(),
    payload:      field.bytea(),
    rawXml:       field.xml(),
    searchQuery:  field.tsquery(),
    searchVector: field.tsvector(),
    severity:     field.smallInt({ required: true, default: { kind: "value", value: 0 } }),
    recordedAt:   field.datetime({ required: true, default: { kind: "now" } }),
  },
  access: {
    read:   access.role("service_role"),
    create: access.role("service_role"),
    update: access.role("service_role"),
    delete: access.role("service_role"),
  },
  options: { timestamps: true },
})

// ── Pages ──────────────────────────────────────────────────────────────────────
// Covers: blocks (multi-type), publishable composite, json, slug, hasOne

export const page = model("page", {
  fields: {
    title:        field.text({ required: true }),
    slug:         field.slug({ from: "title", unique: true }),
    content:      field.blocks([HeroBlock, RichTextBlock, CalloutBlock, ImageGalleryBlock]),
    author:       relation.belongsTo("author", { onDelete: "setNull" }),
    metadata:     field.json<{ seo?: { title?: string; description?: string }; noIndex?: boolean }>(),
    publishState: composites.publishable(),
    timestamps:   composites.timestamps(),
  },
  access: {
    read:   access.any(),
    create: access.role("authenticated"),
    update: access.owner("author"),
    delete: access.role("service_role"),
  },
})

// ── Subscriptions ──────────────────────────────────────────────────────────────
// Covers: bigInt (billing IDs), decimal (amounts), enum (billing period/status),
//         datetime default now, hasMany from author, UUID as FK ref

export const subscription = model("subscription", {
  fields: {
    subscriber:       relation.belongsTo("author", { required: true, onDelete: "cascade" }),
    externalId:       field.bigInt({ required: true, unique: true }),
    planId:           field.uuid({ required: true, index: true }),
    status:           field.enum(["trialing", "active", "past_due", "canceled", "unpaid"], {
      required: true,
      default: "trialing",
    }),
    billingPeriod:    field.enum(["monthly", "annual"], {
      required: true,
      default: "monthly",
    }),
    currentPeriodEnd: field.datetime({ required: true }),
    trialEndsAt:      field.datetime(),
    canceledAt:       field.datetime(),
    quantity:         field.integer({ required: true, default: { kind: "value", value: 1 } }),
    unitAmount:       field.decimal({ required: true, precision: 12, scale: 2 }),
    currency:         field.text({ required: true, default: { kind: "value", value: "usd" }, maxLength: 3 }),
    metadata:         field.json<Record<string, string>>(),
    timestamps:       composites.timestamps(),
  },
  access: {
    read:   access.owner("subscriber"),
    create: access.role("service_role"),
    update: access.role("service_role"),
    delete: access.role("service_role"),
  },
})
