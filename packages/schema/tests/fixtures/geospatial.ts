import { model, field, relation, access, timestamps } from "../../src/index.js"

export const Location = model("location", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    description: field.text(),
    point: field.geo({ required: true, type: "point", srid: 4326 }),
    address: field.text(),
    city: field.text(),
    state: field.text(),
    country: field.text(),
    postalCode: field.text(),
    category: field.enum(["restaurant", "shop", "park", "museum", "hotel", "other"] as const, { required: true }),
    rating: field.float(),
    metadata: field.json(),
    region: relation.belongsTo("region", { foreignKey: "region_id", onDelete: "setNull" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "contributor"),
    update: access.role("admin", "contributor"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["point"], unique: false, using: "gist" },
    { fields: ["category"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const Region = model("region", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    code: field.text({ required: true, unique: true }),
    boundary: field.geo({ required: true, type: "polygon", srid: 4326 }),
    population: field.integer(),
    area: field.float(),
    parent: relation.belongsTo("region", { foreignKey: "parent_id", onDelete: "setNull" }),
    children: relation.hasMany("region"),
    locations: relation.hasMany("location"),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["boundary"], unique: false, using: "gist" },
  ],
  options: { timestamps: true },
})

export const Route = model("route", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    description: field.text(),
    path: field.geo({ required: true, type: "linestring", srid: 4326 }),
    distance: field.float(),
    duration: field.interval(),
    difficulty: field.enum(["easy", "moderate", "hard", "expert"] as const),
    startLocation: relation.belongsTo("location", { foreignKey: "start_location_id" }),
    endLocation: relation.belongsTo("location", { foreignKey: "end_location_id" }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.public(),
    create: access.role("admin", "contributor"),
    update: access.role("admin", "contributor"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["path"], unique: false, using: "gist" },
  ],
  options: { timestamps: true },
})

export const GeoFence = model("geoFence", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    boundary: field.geo({ required: true, type: "polygon", srid: 4326 }),
    isActive: field.boolean({ default: { kind: "value", value: true } }),
    alertRadius: field.float(),
    _timestamps: timestamps(),
  },
  access: {
    read: access.role("admin"),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["boundary"], unique: false, using: "gist" },
  ],
  options: { timestamps: true },
})

export const fixtures = { Location, Region, Route, GeoFence }
