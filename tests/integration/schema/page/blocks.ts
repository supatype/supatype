import type { Block, Default, ImageAsset, Optional, RichText, SmallInt, URL } from "@supatype/types"
import type { heroImages } from "../buckets.js"

export type HeroBlock = Block<"hero", {
  heading: string
  subheading: Optional<string>
  backgroundImage: Optional<ImageAsset<heroImages>>
  ctaLabel: Optional<string>
  ctaUrl: Optional<URL>
}, { icon: "layout"; label: "Hero Section" }>

export type RichTextBlock = Block<"rich_text", {
  content: RichText
}, { icon: "align-left"; label: "Rich Text" }>

export type CalloutBlock = Block<"callout", {
  level: "info" | "warning" | "error" | "success"
  message: string
  icon: Optional<string>
}, { icon: "alert-circle"; label: "Callout" }>

export type ImageGalleryBlock = Block<"image_gallery", {
  caption: Optional<string>
  columns: Default<SmallInt, 3>
  showCaptions: Default<boolean, false>
}, { icon: "image"; label: "Image Gallery" }>
