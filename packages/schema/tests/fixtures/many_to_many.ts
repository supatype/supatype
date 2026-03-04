import { model, field, relation, access, timestamps } from "../../src/index.js"

export const Student = model("student", {
  tableName: "students",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    email: field.email({ required: true, unique: true }),
    enrollmentYear: field.integer({ required: true }),
    gpa: field.decimal({ precision: 3, scale: 2 }),
    courses: relation.manyToMany("course", { through: "enrollments" }),
    clubs: relation.manyToMany("club", { through: "club_memberships" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin", "teacher", "student"),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const Course = model("course", {
  tableName: "courses",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    code: field.text({ required: true, unique: true }),
    name: field.text({ required: true }),
    description: field.richText(),
    credits: field.integer({ required: true, min: 1, max: 6 }),
    maxEnrollment: field.integer(),
    department: field.text({ required: true }),
    instructor: relation.belongsTo("instructor", { foreignKey: "instructor_id", onDelete: "setNull" }),
    students: relation.manyToMany("student", { through: "enrollments" }),
    prerequisites: relation.manyToMany("course", { through: "course_prerequisites" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin", "teacher"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const Instructor = model("instructor", {
  tableName: "instructors",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    email: field.email({ required: true, unique: true }),
    department: field.text({ required: true }),
    title: field.text(),
    courses: relation.hasMany("course"),
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

export const Club = model("club", {
  tableName: "clubs",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true, unique: true }),
    description: field.text(),
    category: field.enum(["academic", "sports", "arts", "social", "volunteer"] as const, { required: true }),
    isActive: field.boolean({ default: { kind: "value", value: true } }),
    members: relation.manyToMany("student", { through: "club_memberships" }),
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

export const Article = model("article", {
  tableName: "articles",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    title: field.text({ required: true }),
    body: field.richText({ required: true }),
    tags: relation.manyToMany("tag", { through: "article_tags" }),
    relatedArticles: relation.manyToMany("article", { through: "related_articles" }),
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

export const Tag = model("tag", {
  tableName: "tags",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true, unique: true }),
    slug: field.slug({ from: "name", required: true }),
    articles: relation.manyToMany("article", { through: "article_tags" }),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
})

export const fixtures = { Student, Course, Instructor, Club, Article, Tag }
