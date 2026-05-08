import type {
  Bucket,
  BucketLoggedIn,
  BucketOwner,
  BucketRole,
  LocaleConfig,
} from "@supatype/types"

export type heroImages = Bucket<"hero-images", { accessMode: "public" }>
export type avatars = Bucket<"avatars", { accessMode: "public" }>
export type postCovers = Bucket<"post-covers", { accessMode: "public" }>
export type postAttachments = Bucket<"post-attachments", {
  accessMode: "private"
  maxSize: "50MB"
  access: {
    read: BucketLoggedIn
    create: BucketLoggedIn
    delete: BucketOwner
  }
}>
export type productManuals = Bucket<"product-manuals", {
  accessMode: "private"
  accept: ["application/pdf"]
  access: {
    read: BucketRole<"service_role">
    create: BucketRole<"service_role">
    delete: BucketRole<"service_role">
  }
}>
export type productImages = Bucket<"products", { accessMode: "public" }>
export type auditLogsBucket = Bucket<"audit-logs", {
  accessMode: "custom"
  s3BucketPolicy: "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::audit-logs/*\"}]}"
  access: {
    read: BucketRole<"service_role">
    create: BucketRole<"service_role">
    delete: BucketRole<"service_role">
  }
}>

export type localeConfig = LocaleConfig<["en", "fr", "de"], "en">
