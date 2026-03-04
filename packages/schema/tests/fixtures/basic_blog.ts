import { model, field, relation, access, timestamps, softDelete } from "../../src/index.js"

export const User = model("user", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    email: field.email({ required: true, unique: true }),
    name: field.text({ required: true }),
    bio: field.text(),
    avatarUrl: field.url(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.private(),
    update: access.owner("id"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const Category = model("category", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true, unique: true }),
    slug: field.slug({ from: "name", required: true }),
    description: field.text(),
    posts: relation.hasMany("post"),
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

export const Post = model("post", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    title: field.text({ required: true, maxLength: 280 }),
    slug: field.slug({ from: "title", required: true }),
    body: field.richText({ required: true }),
    excerpt: field.text({ maxLength: 500 }),
    featured: field.boolean({ default: { kind: "value", value: false } }),
    author: relation.belongsTo("user", { foreignKey: "author_id", onDelete: "cascade" }),
    category: relation.belongsTo("category", { foreignKey: "category_id", onDelete: "setNull" }),
    comments: relation.hasMany("comment"),
    tags: relation.manyToMany("tag", { through: "post_tags" }),
    coverImage: field.image(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "editor"),
    update: access.owner("author_id"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["author_id"], unique: false, using: "btree" },
    { fields: ["category_id"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const Comment = model("comment", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    body: field.text({ required: true }),
    post: relation.belongsTo("post", { foreignKey: "post_id", onDelete: "cascade" }),
    author: relation.belongsTo("user", { foreignKey: "author_id", onDelete: "cascade" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "editor", "member"),
    update: access.owner("author_id"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const Tag = model("tag", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true, unique: true }),
    slug: field.slug({ from: "name", required: true }),
    posts: relation.manyToMany("post", { through: "post_tags" }),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
})

export const fixtures = { User, Category, Post, Comment, Tag }
