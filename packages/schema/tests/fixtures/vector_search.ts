import { model, field, relation, access, timestamps } from "../../src/index.js"

export const Document = model("document", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    title: field.text({ required: true }),
    content: field.text({ required: true }),
    sourceUrl: field.url(),
    mimeType: field.text(),
    tokenCount: field.integer(),
    searchVector: field.tsvector(),
    chunks: relation.hasMany("documentChunk"),
    collection: relation.belongsTo("collection", { foreignKey: "collection_id", onDelete: "cascade" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["searchVector"], unique: false, using: "gin" },
  ],
  options: { timestamps: true },
})

export const DocumentChunk = model("documentChunk", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    document: relation.belongsTo("document", { foreignKey: "document_id", onDelete: "cascade" }),
    chunkIndex: field.integer({ required: true }),
    content: field.text({ required: true }),
    embedding: field.vector({ dimensions: 1536, required: true }),
    tokenCount: field.integer(),
    metadata: field.json<{ page?: number; section?: string }>(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.private(),
    update: access.private(),
    delete: access.private(),
  },
  indexes: [
    { fields: ["embedding"], unique: false, using: "hnsw" },
    { fields: ["document_id", "chunkIndex"], unique: true, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Collection = model("collection", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    description: field.text(),
    embeddingModel: field.text({ required: true, default: { kind: "value", value: "text-embedding-3-small" } }),
    dimensions: field.integer({ required: true, default: { kind: "value", value: 1536 } }),
    documents: relation.hasMany("document"),
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

export const SearchQuery = model("searchQuery", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    query: field.text({ required: true }),
    queryEmbedding: field.vector({ dimensions: 1536, required: true }),
    tsQuery: field.tsquery(),
    collectionId: field.uuid({ required: true, index: true }),
    userId: field.uuid(),
    resultCount: field.integer(),
    latencyMs: field.integer(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin"),
    create: access.private(),
    update: access.private(),
    delete: access.private(),
  },
  indexes: [
    { fields: ["queryEmbedding"], unique: false, using: "hnsw" },
  ],
  options: { timestamps: true },
})

export const fixtures = { Document, DocumentChunk, Collection, SearchQuery }
