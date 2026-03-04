import { model, field, relation, access, timestamps, softDelete } from "../../src/index.js"

export const Workspace = model("workspace", {
  tableName: "workspaces",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    ownerId: field.uuid({ required: true }),
    documents: relation.hasMany("document"),
    folders: relation.hasMany("folder"),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.owner("ownerId"),
    create: access.role("admin", "member"),
    update: access.owner("ownerId"),
    delete: access.owner("ownerId"),
  },
  indexes: [
    { fields: ["ownerId"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const Folder = model("folder", {
  tableName: "folders",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    workspace: relation.belongsTo("workspace", { foreignKey: "workspace_id", onDelete: "cascade" }),
    parent: relation.belongsTo("folder", { foreignKey: "parent_id", onDelete: "cascade" }),
    children: relation.hasMany("folder"),
    documents: relation.hasMany("document"),
    sortOrder: field.integer({ default: { kind: "value", value: 0 } }),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.custom("auth.uid() = (SELECT owner_id FROM workspaces WHERE id = workspace_id)"),
    create: access.role("admin", "member"),
    update: access.role("admin", "member"),
    delete: access.role("admin", "member"),
  },
  indexes: [
    { fields: ["workspace_id"], unique: false, using: "btree" },
    { fields: ["parent_id"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const Document = model("document", {
  tableName: "documents",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    title: field.text({ required: true }),
    body: field.richText(),
    workspace: relation.belongsTo("workspace", { foreignKey: "workspace_id", onDelete: "cascade" }),
    folder: relation.belongsTo("folder", { foreignKey: "folder_id", onDelete: "setNull" }),
    createdBy: field.uuid({ required: true }),
    lastEditedBy: field.uuid(),
    wordCount: field.integer(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.custom("auth.uid() = (SELECT owner_id FROM workspaces WHERE id = workspace_id)"),
    create: access.role("admin", "member"),
    update: access.role("admin", "member"),
    delete: access.role("admin", "member"),
  },
  indexes: [
    { fields: ["workspace_id"], unique: false, using: "btree" },
    { fields: ["folder_id"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const ApiKey = model("apiKey", {
  tableName: "api_keys",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    keyHash: field.text({ required: true }),
    keyPrefix: field.text({ required: true }),
    ownerId: field.uuid({ required: true }),
    scopes: field.arrayOf("TEXT"),
    expiresAt: field.datetime(),
    lastUsedAt: field.datetime(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.owner("ownerId"),
    create: access.role("admin", "member"),
    update: access.owner("ownerId"),
    delete: access.owner("ownerId"),
  },
  indexes: [
    { fields: ["keyHash"], unique: true, using: "btree" },
    { fields: ["ownerId"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const Notification = model("notification", {
  tableName: "notifications",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    userId: field.uuid({ required: true, index: true }),
    type: field.enum(["info", "warning", "error", "success"] as const, { required: true }),
    title: field.text({ required: true }),
    body: field.text(),
    isRead: field.boolean({ default: { kind: "value", value: false } }),
    readAt: field.datetime(),
    metadata: field.json(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.owner("userId"),
    create: access.private(),
    update: access.owner("userId"),
    delete: access.owner("userId"),
  },
  indexes: [
    { fields: ["userId", "isRead"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const fixtures = { Workspace, Folder, Document, ApiKey, Notification }
