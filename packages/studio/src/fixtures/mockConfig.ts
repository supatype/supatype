import type { AdminConfig } from "../config.js"

/**
 * Mock AdminConfig for local development without a running engine.
 * Provides a realistic blog-style schema to exercise all admin panel features.
 */
export const mockConfig: AdminConfig = {
  models: [
    {
      name: "post",
      label: "Post",
      labelPlural: "Posts",
      tableName: "posts",
      apiPath: "/rest/v1/posts",
      primaryKey: "id",
      publishable: true,
      versioning: true,
      softDelete: false,
      timestamps: true,
      hasHooks: false,
      searchFields: ["title", "slug"],
      listColumns: ["title", "status", "author", "created_at"],
      fields: [
        { name: "id", label: "ID", widget: "uuid", required: true, localized: false, hidden: true, readOnly: true },
        { name: "title", label: "Title", widget: "text", required: true, localized: true, listColumn: true, searchable: true, sortable: true },
        { name: "slug", label: "Slug", widget: "slug", required: true, localized: false, listColumn: true, searchable: true },
        { name: "content", label: "Content", widget: "richtext", required: false, localized: true },
        { name: "excerpt", label: "Excerpt", widget: "textarea", required: false, localized: true },
        { name: "cover_image", label: "Cover Image", widget: "image", required: false, localized: false },
        { name: "status", label: "Status", widget: "publish", required: true, localized: false, listColumn: true, filterable: true },
        { name: "author", label: "Author", widget: "relation", required: true, localized: false, listColumn: true, options: { target: "authors", displayField: "name" } },
        { name: "tags", label: "Tags", widget: "multirelation", required: false, localized: false, options: { target: "tags", displayField: "name" } },
        { name: "category", label: "Category", widget: "select", required: false, localized: false, filterable: true, options: { values: ["tech", "design", "business", "lifestyle"] } },
        { name: "body_blocks", label: "Body Blocks", widget: "blocks", required: false, localized: false, options: { blockTypes: [
          { name: "text", label: "Text Block", fields: [
            { name: "body", label: "Body", widget: "richtext", required: true, localized: true },
          ]},
          { name: "image", label: "Image Block", fields: [
            { name: "src", label: "Image", widget: "image", required: true, localized: false },
            { name: "caption", label: "Caption", widget: "text", required: false, localized: true },
          ]},
          { name: "code", label: "Code Block", fields: [
            { name: "language", label: "Language", widget: "select", required: true, localized: false, options: { values: ["typescript", "javascript", "python", "rust", "sql"] } },
            { name: "code", label: "Code", widget: "textarea", required: true, localized: false },
          ]},
        ]}},
        { name: "metadata", label: "Metadata", widget: "json", required: false, localized: false },
        { name: "created_at", label: "Created", widget: "datetime", required: false, localized: false, listColumn: true, sortable: true, readOnly: true },
        { name: "updated_at", label: "Updated", widget: "datetime", required: false, localized: false, readOnly: true },
      ],
    },
    {
      name: "author",
      label: "Author",
      labelPlural: "Authors",
      tableName: "authors",
      apiPath: "/rest/v1/authors",
      primaryKey: "id",
      publishable: false,
      versioning: false,
      softDelete: false,
      timestamps: true,
      hasHooks: false,
      searchFields: ["name", "email"],
      listColumns: ["name", "email", "created_at"],
      fields: [
        { name: "id", label: "ID", widget: "uuid", required: true, localized: false, hidden: true, readOnly: true },
        { name: "name", label: "Name", widget: "text", required: true, localized: false, listColumn: true, searchable: true, sortable: true },
        { name: "email", label: "Email", widget: "email", required: true, localized: false, listColumn: true, searchable: true },
        { name: "bio", label: "Bio", widget: "textarea", required: false, localized: true },
        { name: "avatar", label: "Avatar", widget: "image", required: false, localized: false },
        { name: "created_at", label: "Created", widget: "datetime", required: false, localized: false, listColumn: true, sortable: true, readOnly: true },
      ],
    },
    {
      name: "tag",
      label: "Tag",
      labelPlural: "Tags",
      tableName: "tags",
      apiPath: "/rest/v1/tags",
      primaryKey: "id",
      publishable: false,
      versioning: false,
      softDelete: false,
      timestamps: false,
      hasHooks: false,
      searchFields: ["name"],
      listColumns: ["name", "slug", "color"],
      fields: [
        { name: "id", label: "ID", widget: "uuid", required: true, localized: false, hidden: true, readOnly: true },
        { name: "name", label: "Name", widget: "text", required: true, localized: false, listColumn: true, searchable: true, sortable: true },
        { name: "slug", label: "Slug", widget: "slug", required: true, localized: false, listColumn: true },
        { name: "color", label: "Color", widget: "color", required: false, localized: false, listColumn: true },
      ],
    },
  ],
  globals: [
    {
      name: "siteSettings",
      label: "Site Settings",
      tableName: "_global_site_settings",
      apiPath: "/rest/v1/_global_site_settings",
      fields: [
        { name: "site_name", label: "Site Name", widget: "text", required: true, localized: true },
        { name: "tagline", label: "Tagline", widget: "text", required: false, localized: true },
        { name: "logo", label: "Logo", widget: "image", required: false, localized: false },
        { name: "favicon", label: "Favicon", widget: "image", required: false, localized: false },
        { name: "footer_text", label: "Footer Text", widget: "richtext", required: false, localized: true },
        { name: "social_links", label: "Social Links", widget: "json", required: false, localized: false },
      ],
    },
    {
      name: "navigation",
      label: "Navigation",
      tableName: "_global_navigation",
      apiPath: "/rest/v1/_global_navigation",
      fields: [
        { name: "items", label: "Nav Items", widget: "json", required: true, localized: false },
      ],
    },
  ],
  navigation: [
    {
      label: "Content",
      items: [
        { label: "Dashboard", href: "/", type: "dashboard", icon: "home" },
        { label: "Posts", href: "/collections/post", type: "model", icon: "file-text" },
        { label: "Authors", href: "/collections/author", type: "model", icon: "users" },
        { label: "Tags", href: "/collections/tag", type: "model", icon: "tag" },
      ],
    },
    {
      label: "Media",
      items: [
        { label: "Media Library", href: "/media", type: "media", icon: "image" },
      ],
    },
    {
      label: "Settings",
      items: [
        { label: "Site Settings", href: "/globals/siteSettings", type: "global", icon: "settings" },
        { label: "Navigation", href: "/globals/navigation", type: "global", icon: "menu" },
      ],
    },
  ],
  locale: {
    locales: [
      { code: "en", label: "English" },
      { code: "fr", label: "French" },
      { code: "de", label: "German" },
    ],
    defaultLocale: "en",
  },
  branding: {
    appName: "Supatype Studio",
    primaryColor: "#7c3aed",
  },
}
