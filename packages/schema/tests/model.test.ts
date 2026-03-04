import { describe, it, expect } from "vitest"
import { model } from "../src/model.js"
import { text, integer, uuid } from "../src/fields.js"
import { belongsTo, hasMany } from "../src/relations.js"
import { publicAccess, role } from "../src/access.js"

describe("model()", () => {
  it("creates a model with name and fields", () => {
    const Post = model("post", {
      fields: {
        id: uuid({ required: true }),
        title: text({ required: true }),
      },
    })
    expect(Post.__modelMeta.name).toBe("post")
    expect(Post.__modelMeta.tableName).toBe("post")
    expect(Post.fields.id).toBeDefined()
    expect(Post.fields.title).toBeDefined()
  })

  it("auto-generates snake_case table name from camelCase", () => {
    const UserProfile = model("userProfile", {
      fields: { id: uuid({ required: true }) },
    })
    expect(UserProfile.__modelMeta.tableName).toBe("user_profile")
  })

  it("allows custom tableName", () => {
    const Item = model("item", {
      fields: { id: uuid({ required: true }) },
      tableName: "custom_items_table",
    })
    expect(Item.__modelMeta.tableName).toBe("custom_items_table")
  })

  it("defaults access to empty object", () => {
    const M = model("m", { fields: { id: uuid({ required: true }) } })
    expect(M.__modelMeta.access).toEqual({})
  })

  it("stores access rules", () => {
    const M = model("m", {
      fields: { id: uuid({ required: true }) },
      access: {
        read: publicAccess(),
        create: role("admin"),
      },
    })
    expect(M.__modelMeta.access.read).toEqual({ type: "public" })
    expect(M.__modelMeta.access.create).toEqual({ type: "role", roles: ["admin"] })
  })

  it("stores indexes", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        name: text({ required: true }),
      },
      indexes: [{ fields: ["name"], unique: true, using: "btree" }],
    })
    expect(M.__modelMeta.indexes).toHaveLength(1)
    expect(M.__modelMeta.indexes[0]!.unique).toBe(true)
  })

  it("defaults options to empty object", () => {
    const M = model("m", { fields: { id: uuid({ required: true }) } })
    expect(M.__modelMeta.options).toEqual({})
  })

  it("stores options", () => {
    const M = model("m", {
      fields: { id: uuid({ required: true }) },
      options: { timestamps: true, softDelete: true },
    })
    expect(M.__modelMeta.options.timestamps).toBe(true)
    expect(M.__modelMeta.options.softDelete).toBe(true)
  })

  it("handles relations in fields", () => {
    const Post = model("post", {
      fields: {
        id: uuid({ required: true }),
        author: belongsTo("user", { foreignKey: "author_id", onDelete: "cascade" }),
        comments: hasMany("comment"),
      },
    })
    expect(Post.fields.author.__meta.kind).toBe("relation")
    expect(Post.fields.comments.__meta.kind).toBe("relation")
  })
})
