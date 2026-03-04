import { model, field, relation, access, timestamps, softDelete } from "../../src/index.js"

export const Organisation = model("organisation", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    logo: field.image(),
    plan: field.enum(["free", "starter", "pro", "enterprise"] as const, { required: true, default: "free" }),
    stripeSubscriptionId: field.text(),
    trialEndsAt: field.datetime(),
    members: relation.hasMany("member"),
    projects: relation.hasMany("project"),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.custom("auth.uid() IN (SELECT user_id FROM members WHERE organisation_id = id)"),
    create: access.role("admin", "member"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  options: { timestamps: true, softDelete: true },
})

export const Member = model("member", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    organisation: relation.belongsTo("organisation", { foreignKey: "organisation_id", onDelete: "cascade" }),
    userId: field.uuid({ required: true }),
    role: field.enum(["owner", "admin", "member", "viewer"] as const, { required: true, default: "member" }),
    invitedBy: field.uuid(),
    invitedAt: field.datetime(),
    acceptedAt: field.datetime(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.custom("auth.uid() IN (SELECT user_id FROM members WHERE organisation_id = organisation_id)"),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["organisation_id", "userId"], unique: true, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Project = model("project", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    organisation: relation.belongsTo("organisation", { foreignKey: "organisation_id", onDelete: "cascade" }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    description: field.text(),
    isPublic: field.boolean({ default: { kind: "value", value: false } }),
    settings: field.json<{ color?: string; icon?: string }>(),
    tasks: relation.hasMany("task"),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.custom("auth.uid() IN (SELECT user_id FROM members WHERE organisation_id = organisation_id)"),
    create: access.role("admin", "member"),
    update: access.role("admin", "member"),
    delete: access.role("admin"),
  },
  options: { timestamps: true, softDelete: true },
})

export const Task = model("task", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    project: relation.belongsTo("project", { foreignKey: "project_id", onDelete: "cascade" }),
    title: field.text({ required: true }),
    description: field.richText(),
    status: field.enum(["backlog", "todo", "in_progress", "review", "done"] as const, { required: true, default: "backlog" }),
    priority: field.enum(["low", "medium", "high", "urgent"] as const, { required: true, default: "medium" }),
    assigneeId: field.uuid(),
    dueDate: field.date(),
    estimatedHours: field.float(),
    sortOrder: field.integer({ default: { kind: "value", value: 0 } }),
    labels: relation.manyToMany("label", { through: "task_labels" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.custom("auth.uid() IN (SELECT m.user_id FROM members m JOIN projects p ON p.organisation_id = m.organisation_id WHERE p.id = project_id)"),
    create: access.role("admin", "member"),
    update: access.role("admin", "member"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["project_id", "status"], unique: false, using: "btree" },
    { fields: ["assigneeId"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Label = model("label", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    color: field.text({ required: true }),
    organisationId: field.uuid({ required: true }),
    tasks: relation.manyToMany("task", { through: "task_labels" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.custom("auth.uid() IN (SELECT user_id FROM members WHERE organisation_id = organisation_id)"),
    create: access.role("admin", "member"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["organisationId", "name"], unique: true, using: "btree" },
  ],
  options: { timestamps: true },
})

export const AuditLog = model("auditLog", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    organisationId: field.uuid({ required: true, index: true }),
    userId: field.uuid({ required: true }),
    action: field.text({ required: true }),
    resource: field.text({ required: true }),
    resourceId: field.uuid(),
    metadata: field.json(),
    ipAddress: field.ip(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin"),
    create: access.private(),
    update: access.private(),
    delete: access.private(),
  },
  indexes: [
    { fields: ["organisationId"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const fixtures = { Organisation, Member, Project, Task, Label, AuditLog }
