import { model, field, relation, access, timestamps, publishable, softDelete } from "../../src/index.js"

export const AllScalarTypes = model("allScalarTypes", {
  tableName: "all_scalar_types",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    textField: field.text({ required: true }),
    textWithMax: field.text({ maxLength: 255 }),
    richTextField: field.richText(),
    integerField: field.integer({ required: true }),
    integerWithRange: field.integer({ min: 0, max: 100 }),
    smallIntField: field.smallInt(),
    serialField: field.serial(),
    bigSerialField: field.bigSerial(),
    floatField: field.float(),
    booleanField: field.boolean({ default: { kind: "value", value: false } }),
    dateField: field.date(),
    timestampField: field.timestamp(),
    datetimeField: field.datetime({ default: { kind: "now" } }),
    uuidField: field.uuid(),
    emailField: field.email({ unique: true }),
    urlField: field.url(),
    ipField: field.ip(),
    cidrField: field.cidr(),
    macaddrField: field.macaddr(),
    intervalField: field.interval(),
    tsqueryField: field.tsquery(),
    tsvectorField: field.tsvector(),
    byteaField: field.bytea(),
    moneyField: field.money(),
    xmlField: field.xml(),
    bigIntField: field.bigInt(),
    slugField: field.slug({ from: "textField" }),
    enumField: field.enum(["a", "b", "c", "d"] as const, { default: "a" }),
    decimalField: field.decimal({ precision: 18, scale: 6 }),
    jsonField: field.json<{ nested: { value: number } }>(),
    imageField: field.image({ bucket: "test-images" }),
    fileField: field.file({ bucket: "test-files" }),
    geoPointField: field.geo({ type: "point" }),
    geoPolygonField: field.geo({ type: "polygon" }),
    geoLinestringField: field.geo({ type: "linestring", srid: 3857 }),
    vectorField: field.vector({ dimensions: 384 }),
    textArrayField: field.arrayOf("TEXT"),
    intArrayField: field.arrayOf("INTEGER"),
    uuidArrayField: field.arrayOf("UUID"),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["tsvectorField"], unique: false, using: "gin" },
    { fields: ["geoPointField"], unique: false, using: "gist" },
    { fields: ["vectorField"], unique: false, using: "hnsw" },
    { fields: ["jsonField"], unique: false, using: "gin" },
  ],
  options: { timestamps: true },
})

export const AllRelationTypes = model("allRelationTypes", {
  tableName: "all_relation_types",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    belongsToRequired: relation.belongsTo("allScalarTypes", { foreignKey: "scalar_id", onDelete: "cascade" }),
    belongsToOptional: relation.belongsTo("allScalarTypes", { foreignKey: "optional_scalar_id", onDelete: "setNull" }),
    hasOneTarget: relation.hasOne("singleChild"),
    hasManyTargets: relation.hasMany("multiChild"),
    manyToManyTargets: relation.manyToMany("peerModel", { through: "relation_peers" }),
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

export const SingleChild = model("singleChild", {
  tableName: "single_children",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    parent: relation.belongsTo("allRelationTypes", { foreignKey: "parent_id", onDelete: "cascade" }),
    value: field.text({ required: true }),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
})

export const MultiChild = model("multiChild", {
  tableName: "multi_children",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    parent: relation.belongsTo("allRelationTypes", { foreignKey: "parent_id", onDelete: "cascade" }),
    value: field.text({ required: true }),
    sortOrder: field.integer({ default: { kind: "value", value: 0 } }),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
})

export const PeerModel = model("peerModel", {
  tableName: "peer_models",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    peers: relation.manyToMany("allRelationTypes", { through: "relation_peers" }),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
})

export const AllAccessPatterns = model("allAccessPatterns", {
  tableName: "all_access_patterns",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    ownerId: field.uuid({ required: true }),
    publicField: field.text(),
    privateField: field.text(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "editor", "member"),
    update: access.owner("ownerId"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const AllAccessPrivate = model("allAccessPrivate", {
  tableName: "all_access_private",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    secret: field.text({ required: true }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.private(),
    create: access.private(),
    update: access.private(),
    delete: access.private(),
  },
  options: { timestamps: true },
})

export const AllAccessCustom = model("allAccessCustom", {
  tableName: "all_access_custom",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    tenantId: field.uuid({ required: true }),
    data: field.json(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.custom("auth.uid() IN (SELECT user_id FROM tenant_members WHERE tenant_id = tenant_id)"),
    create: access.custom("auth.role() = 'admin' OR auth.uid() IN (SELECT user_id FROM tenant_members WHERE tenant_id = tenant_id AND role = 'editor')"),
    update: access.owner("tenantId"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const CompositeShowcase = model("compositeShowcase", {
  tableName: "composite_showcase",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    title: field.text({ required: true }),
    _publishable: publishable(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  options: { timestamps: true, softDelete: true },
})

export const IndexShowcase = model("indexShowcase", {
  tableName: "index_showcase",
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    email: field.email({ required: true }),
    status: field.enum(["active", "inactive"] as const, { required: true }),
    searchVector: field.tsvector(),
    location: field.geo({ type: "point" }),
    embedding: field.vector({ dimensions: 768 }),
    tags: field.arrayOf("TEXT"),
    metadata: field.json(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["name", "email"], unique: true, using: "btree" },
    { fields: ["status"], unique: false, using: "btree" },
    { fields: ["searchVector"], unique: false, using: "gin" },
    { fields: ["location"], unique: false, using: "gist" },
    { fields: ["embedding"], unique: false, using: "hnsw" },
    { fields: ["tags"], unique: false, using: "gin" },
    { fields: ["metadata"], unique: false, using: "gin" },
  ],
  options: { timestamps: true },
})

export const fixtures = {
  AllScalarTypes,
  AllRelationTypes,
  SingleChild,
  MultiChild,
  PeerModel,
  AllAccessPatterns,
  AllAccessPrivate,
  AllAccessCustom,
  CompositeShowcase,
  IndexShowcase,
}
