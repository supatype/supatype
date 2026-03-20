import { defineComposite } from "@supatype/plugin-sdk"

export default defineComposite({
  name: "seo",
  label: "SEO Meta",
  fields: [
    { name: "meta_title", type: "text", options: { maxLength: 60 } },
    { name: "meta_description", type: "text", options: { maxLength: 160 } },
    { name: "og_image", type: "text" },
    { name: "canonical_url", type: "text" },
    { name: "no_index", type: "boolean", defaultValue: false },
  ],
  adminGroup: { collapsible: true, defaultCollapsed: true },
})
