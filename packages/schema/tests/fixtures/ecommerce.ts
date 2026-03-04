import { model, field, relation, access, timestamps, softDelete } from "../../src/index.js"

export const Customer = model("customer", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    email: field.email({ required: true, unique: true }),
    name: field.text({ required: true }),
    phone: field.text(),
    stripeCustomerId: field.text({ unique: true }),
    _timestamps: timestamps(),
  },
  access: {
    read: access.owner("id"),
    create: access.public(),
    update: access.owner("id"),
    delete: access.role("admin"),
  },
  options: { timestamps: true },
})

export const Product = model("product", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    description: field.richText(),
    price: field.decimal({ required: true, precision: 10, scale: 2 }),
    compareAtPrice: field.decimal({ precision: 10, scale: 2 }),
    sku: field.text({ unique: true }),
    barcode: field.text(),
    weight: field.float(),
    status: field.enum(["draft", "active", "archived"] as const, { required: true, default: "draft" }),
    featured: field.boolean({ default: { kind: "value", value: false } }),
    categories: relation.manyToMany("productCategory", { through: "product_category_assignments" }),
    variants: relation.hasMany("productVariant"),
    images: field.json<Array<{ url: string; alt: string; position: number }>>(),
    primaryImage: field.image(),
    _timestamps: timestamps(),
    _softDelete: softDelete(),
  },
  access: {
    read: access.public(),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["status"], unique: false, using: "btree" },
  ],
  options: { timestamps: true, softDelete: true },
})

export const ProductCategory = model("productCategory", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    name: field.text({ required: true }),
    slug: field.slug({ from: "name", required: true }),
    description: field.text(),
    parentId: field.uuid(),
    sortOrder: field.integer({ default: { kind: "value", value: 0 } }),
    products: relation.manyToMany("product", { through: "product_category_assignments" }),
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

export const ProductVariant = model("productVariant", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    product: relation.belongsTo("product", { foreignKey: "product_id", onDelete: "cascade" }),
    name: field.text({ required: true }),
    sku: field.text({ unique: true }),
    price: field.decimal({ required: true, precision: 10, scale: 2 }),
    inventoryCount: field.integer({ required: true, default: { kind: "value", value: 0 }, min: 0 }),
    options: field.json<Record<string, string>>(),
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

export const Order = model("order", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    orderNumber: field.serial(),
    customer: relation.belongsTo("customer", { foreignKey: "customer_id", onDelete: "restrict" }),
    status: field.enum(
      ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded"] as const,
      { required: true, default: "pending" },
    ),
    subtotal: field.decimal({ required: true, precision: 10, scale: 2 }),
    tax: field.decimal({ required: true, precision: 10, scale: 2 }),
    shipping: field.decimal({ required: true, precision: 10, scale: 2 }),
    total: field.decimal({ required: true, precision: 10, scale: 2 }),
    currency: field.text({ required: true, default: { kind: "value", value: "USD" } }),
    shippingAddress: field.json<{ line1: string; line2?: string; city: string; state: string; zip: string; country: string }>({ required: true }),
    notes: field.text(),
    items: relation.hasMany("orderItem"),
    _timestamps: timestamps(),
  },
  access: {
    read: access.owner("customer_id"),
    create: access.role("admin", "member"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
  indexes: [
    { fields: ["customer_id"], unique: false, using: "btree" },
    { fields: ["status"], unique: false, using: "btree" },
  ],
  options: { timestamps: true },
})

export const OrderItem = model("orderItem", {
  fields: {
    id: field.uuid({ required: true, default: { kind: "genRandomUuid" } }),
    order: relation.belongsTo("order", { foreignKey: "order_id", onDelete: "cascade" }),
    variant: relation.belongsTo("productVariant", { foreignKey: "variant_id", onDelete: "restrict" }),
    quantity: field.integer({ required: true, min: 1 }),
    unitPrice: field.decimal({ required: true, precision: 10, scale: 2 }),
    total: field.decimal({ required: true, precision: 10, scale: 2 }),
  },
  access: {
    read: access.role("admin", "member"),
    create: access.role("admin"),
    update: access.role("admin"),
    delete: access.role("admin"),
  },
})

export const fixtures = { Customer, Product, ProductCategory, ProductVariant, Order, OrderItem }
