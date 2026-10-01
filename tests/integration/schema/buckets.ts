import type {
  Bucket,
  BucketLoggedIn,
  BucketOwner,
  BucketPublic,
  BucketRole,
  LocaleConfig,
} from "@supatype/types"

// Anyone may read, a signed-in user may upload, and only the uploader may replace or remove it.
// Every operation is its own rule, and one left out is refused.
type PublicImages = {
  read: BucketPublic
  create: BucketLoggedIn
  update: BucketOwner
  delete: BucketOwner
}

export type heroImages = Bucket<"hero-images", {
  accessMode: "public"
  access: PublicImages
}>
export type avatars = Bucket<"avatars", {
  accessMode: "public"
  access: PublicImages
}>
export type postCovers = Bucket<"post-covers", {
  accessMode: "public"
  access: PublicImages
}>
export type postAttachments = Bucket<"post-attachments", {
  accessMode: "private"
  maxSize: "50MB"
  access: {
    read: BucketLoggedIn
    create: BucketLoggedIn
    update: BucketOwner
    delete: BucketOwner
  }
}>
export type productManuals = Bucket<"product-manuals", {
  accessMode: "private"
  accept: ["application/pdf"]
  access: {
    read: BucketRole<"service_role">
    create: BucketRole<"service_role">
    update: BucketRole<"service_role">
    delete: BucketRole<"service_role">
  }
}>
export type productImages = Bucket<"products", {
  accessMode: "public"
  access: PublicImages
}>
export type auditLogsBucket = Bucket<"audit-logs", {
  accessMode: "custom"
  s3BucketPolicy: "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::audit-logs/*\"}]}"
  access: {
    read: BucketRole<"service_role">
    create: BucketRole<"service_role">
    update: BucketRole<"service_role">
    delete: BucketRole<"service_role">
  }
}>

export type localeConfig = LocaleConfig<["en", "fr", "de"], "en">
