import { describe, it, expect } from "vitest"
import { serialiseSchema } from "../src/serialiser.js"
import { model } from "../src/model.js"
import { text, integer, uuid, enumField, decimal, json, image, geo, vector, slug, arrayOf, boolean, datetime, email } from "../src/fields.js"
import { belongsTo, hasMany, manyToMany } from "../src/relations.js"
import { publicAccess, role, owner } from "../src/access.js"
import { timestamps, publishable, softDelete } from "../src/composites.js"

describe("serialiseSchema()", () => {
  it("serialises a simple model", () => {
    const User = model("user", {
      fields: {
        id: uuid({ required: true, default: { kind: "genRandomUuid" } }),
        name: text({ required: true }),
        email: email({ required: true, unique: true }),
      },
      access: {
        read: publicAccess(),
        create: role("admin"),
      },
      options: { timestamps: true },
    })

    const ast = serialiseSchema({ User })
    expect(ast.models).toHaveLength(1)

    const m = ast.models[0]!
    expect(m.name).toBe("user")
    expect(m.tableName).toBe("user")
    expect(m.fields.id.kind).toBe("uuid")
    expect(m.fields.id.pgType).toBe("UUID")
    expect(m.fields.id.required).toBe(true)
    expect(m.fields.name.kind).toBe("text")
    expect(m.fields.email.kind).toBe("email")
    expect(m.fields.email.unique).toBe(true)
    expect(m.access.read).toEqual({ type: "public" })
    expect(m.options.timestamps).toBe(true)
  })

  it("serialises relations", () => {
    const Post = model("post", {
      fields: {
        id: uuid({ required: true }),
        author: belongsTo("user", { foreignKey: "author_id", onDelete: "cascade" }),
        comments: hasMany("comment"),
        tags: manyToMany("tag", { through: "post_tags" }),
      },
    })

    const ast = serialiseSchema({ Post })
    const fields = ast.models[0]!.fields

    expect(fields.author.kind).toBe("relation")
    expect(fields.author.cardinality).toBe("belongsTo")
    expect(fields.author.target).toBe("user")
    expect(fields.author.foreignKey).toBe("author_id")
    expect(fields.author.onDelete).toBe("cascade")

    expect(fields.comments.kind).toBe("relation")
    expect(fields.comments.cardinality).toBe("hasMany")

    expect(fields.tags.kind).toBe("relation")
    expect(fields.tags.cardinality).toBe("manyToMany")
    expect(fields.tags.through).toBe("post_tags")
  })

  it("serialises composites", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        _ts: timestamps(),
        _pub: publishable(),
        _sd: softDelete(),
      },
    })

    const ast = serialiseSchema({ M })
    const fields = ast.models[0]!.fields

    expect(fields._ts.kind).toBe("timestamps")
    expect(fields._pub.kind).toBe("publishable")
    expect(fields._sd.kind).toBe("softDelete")
  })

  it("serialises enum fields with values", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        status: enumField(["a", "b", "c"] as const, { required: true, default: "a" }),
      },
    })

    const ast = serialiseSchema({ M })
    const status = ast.models[0]!.fields.status

    expect(status.kind).toBe("enum")
    expect(status.values).toEqual(["a", "b", "c"])
    expect(status.required).toBe(true)
    expect(status.default).toBe("a")
    expect(status.pgType).toBe("TEXT")
  })

  it("serialises decimal fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        price: decimal({ precision: 10, scale: 2, required: true }),
      },
    })

    const ast = serialiseSchema({ M })
    const price = ast.models[0]!.fields.price

    expect(price.kind).toBe("decimal")
    expect(price.pgType).toBe("NUMERIC(10, 2)")
    expect(price.precision).toBe(10)
    expect(price.scale).toBe(2)
  })

  it("serialises json fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        data: json({ required: true }),
      },
    })

    const ast = serialiseSchema({ M })
    expect(ast.models[0]!.fields.data.kind).toBe("json")
    expect(ast.models[0]!.fields.data.pgType).toBe("JSONB")
  })

  it("serialises storage fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        avatar: image({ bucket: "avatars" }),
      },
    })

    const ast = serialiseSchema({ M })
    const avatar = ast.models[0]!.fields.avatar

    expect(avatar.kind).toBe("image")
    expect(avatar.pgType).toBe("JSONB")
    expect(avatar.bucket).toBe("avatars")
  })

  it("serialises geo fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        location: geo({ type: "point", srid: 4326, required: true }),
      },
    })

    const ast = serialiseSchema({ M })
    const loc = ast.models[0]!.fields.location

    expect(loc.kind).toBe("geo")
    expect(loc.pgType).toBe("GEOGRAPHY(POINT, 4326)")
    expect(loc.geoType).toBe("point")
  })

  it("serialises vector fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        embedding: vector({ dimensions: 1536, required: true }),
      },
    })

    const ast = serialiseSchema({ M })
    const emb = ast.models[0]!.fields.embedding

    expect(emb.kind).toBe("vector")
    expect(emb.pgType).toBe("vector(1536)")
    expect(emb.dimensions).toBe(1536)
  })

  it("serialises slug fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        title: text({ required: true }),
        slug: slug({ from: "title" }),
      },
    })

    const ast = serialiseSchema({ M })
    const s = ast.models[0]!.fields.slug

    expect(s.kind).toBe("slug")
    expect(s.from).toBe("title")
    expect(s.unique).toBe(true)
  })

  it("serialises array fields", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        tags: arrayOf("TEXT", { required: true }),
      },
    })

    const ast = serialiseSchema({ M })
    const tags = ast.models[0]!.fields.tags

    expect(tags.kind).toBe("array")
    expect(tags.pgType).toBe("TEXT[]")
    expect(tags.elementType).toBe("TEXT")
    expect(tags.required).toBe(true)
  })

  it("serialises indexes", () => {
    const M = model("m", {
      fields: {
        id: uuid({ required: true }),
        name: text({ required: true }),
      },
      indexes: [
        { fields: ["name"], unique: true, using: "btree" as const },
      ],
    })

    const ast = serialiseSchema({ M })
    expect(ast.models[0]!.indexes).toHaveLength(1)
    expect(ast.models[0]!.indexes[0]!.unique).toBe(true)
  })

  it("serialises multiple models", () => {
    const User = model("user", {
      fields: { id: uuid({ required: true }), name: text({ required: true }) },
    })
    const Post = model("post", {
      fields: { id: uuid({ required: true }), title: text({ required: true }) },
    })

    const ast = serialiseSchema({ User, Post })
    expect(ast.models).toHaveLength(2)
    expect(ast.models.map(m => m.name)).toContain("user")
    expect(ast.models.map(m => m.name)).toContain("post")
  })
})
