import { model, field, relation, access, timestamps, publishable, softDelete } from "../../src/index.js"

export const Page = model("page", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    title: field.text({ required: true }),
    slug: field.slug({ from: "title", required: true }),
    description: field.text({ maxLength: 300 }),
    template: field.enum(["default", "landing", "sidebar", "fullWidth"] as const, { required: true, default: "default" }),
    sortOrder: field.integer({ default: { kind: "value", value: 0 } }),
    parent: relation.belongsTo("page", { foreignKey: "parent_id", onDelete: "setNull" }),
    children: relation.hasMany("page"),
    blocks: relation.hasMany("block"),
    seoTitle: field.text({ maxLength: 70 }),
    seoDescription: field.text({ maxLength: 160 }),
    ogImage: field.image(),
    _publishable: publishable(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "editor"),
    update: access.role("admin", "editor"),
    delete: access.role("admin"),
  },
  options: { timestamps: true, softDelete: true },
})

export const Block = model("block", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    page: relation.belongsTo("page", { foreignKey: "page_id", onDelete: "cascade" }),
    type: field.enum(
      ["hero", "text", "image", "gallery", "video", "cta", "testimonial", "faq", "form", "custom"] as const,
      { required: true },
    ),
    content: field.json<Record<string, unknown>>({ required: true }),
    sortOrder: field.integer({ required: true, default: { kind: "value", value: 0 } }),
    isVisible: field.boolean({ default: { kind: "value", value: true } }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "editor"),
    update: access.role("admin", "editor"),
    delete: access.role("admin", "editor"),
  },
  indexes: [
    { fields: ["page_id", "sortOrder"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Media = model("media", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    altText: field.text(),
    file: field.file({ required: true }),
    mimeType: field.text({ required: true }),
    fileSize: field.integer({ required: true }),
    width: field.integer(),
    height: field.integer(),
    folder: relation.belongsTo("mediaFolder", { foreignKey: "folder_id", onDelete: "setNull" }),
    uploadedBy: field.uuid({ required: true }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "editor"),
    update: access.role("admin", "editor"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const MediaFolder = model("mediaFolder", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    parent: relation.belongsTo("mediaFolder", { foreignKey: "parent_id", onDelete: "cascade" }),
    children: relation.hasMany("mediaFolder"),
    media: relation.hasMany("media"),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin", "editor"),
    create: access.role("admin", "editor"),
    update: access.role("admin", "editor"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const ContentVersion = model("contentVersion", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    pageId: field.uuid({ required: true, index: true }),
    versionNumber: field.integer({ required: true }),
    snapshot: field.json<Record<string, unknown>>({ required: true }),
    changelog: field.text(),
    createdBy: field.uuid({ required: true }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin", "editor"),
    create: access.private(),
    update: access.private(),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["pageId", "versionNumber"], unique: true, using: "btree" },
  ],
  options: { timestamps: true },
})

export const NavigationMenu = model("navigationMenu", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true, unique: true }),
    slug: field.slug({ from: "name", required: true }),
    items: field.json<Array<{ label: string; url: string; children?: Array<{ label: string; url: string }> }>>({ required: true }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const fixtures = { Page, Block, Media, MediaFolder, ContentVersion, NavigationMenu }
