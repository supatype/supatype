import { model, field, relation, access, timestamps } from "../../src/index.js"

export const Category = model("category", {
  tableName: "categories",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    description: field.text(),
    depth: field.integer({ required: true, default: { kind: "value", value: 0 } }),
    sortOrder: field.integer({ default: { kind: "value", value: 0 } }),
    parent: relation.belongsTo("category", { foreignKey: "parent_id", onDelete: "cascade" }),
    children: relation.hasMany("category"),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["parent_id"], unique: false, using: "btree" },
    { fields: ["parent_id", "sortOrder"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Employee = model("employee", {
  tableName: "employees",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    email: field.email({ required: true, unique: true }),
    title: field.text({ required: true }),
    department: field.text(),
    manager: relation.belongsTo("employee", { foreignKey: "manager_id", onDelete: "setNull" }),
    directReports: relation.hasMany("employee"),
    hireDate: field.date({ required: true }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin", "hr", "member"),
    create: access.role("admin", "hr"),
    update: access.role("admin", "hr"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["manager_id"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Comment = model("comment", {
  tableName: "comments",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    body: field.text({ required: true }),
    authorId: field.uuid({ required: true }),
    postId: field.uuid({ required: true, index: true }),
    parent: relation.belongsTo("comment", { foreignKey: "parent_id", onDelete: "cascade" }),
    replies: relation.hasMany("comment"),
    depth: field.integer({ required: true, default: { kind: "value", value: 0 } }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "member"),
    update: access.owner("authorId"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["parent_id"], unique: false, using: "btree" },
    { fields: ["postId", "parent_id"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const MenuItem = model("menuItem", {
  tableName: "menu_items",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    label: field.text({ required: true }),
    url: field.text(),
    icon: field.text(),
    parent: relation.belongsTo("menuItem", { foreignKey: "parent_id", onDelete: "cascade" }),
    children: relation.hasMany("menuItem"),
    sortOrder: field.integer({ required: true, default: { kind: "value", value: 0 } }),
    isVisible: field.boolean({ default: { kind: "value", value: true } }),
    menuGroup: field.text({ required: true, default: { kind: "value", value: "main" } }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["menuGroup", "parent_id", "sortOrder"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const fixtures = { Category, Employee, Comment, MenuItem }
