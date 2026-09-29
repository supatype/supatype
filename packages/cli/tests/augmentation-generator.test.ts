import { describe, expect, it } from "vitest"
import { generateClientAugmentation, generateRowType } from "../src/augmentation-generator.js"

describe("generateClientAugmentation", () => {
  it("emits models in the order the schema declares them", () => {
    const astA = {
      models: [
        {
          name: "Post",
          fields: { title: { kind: "text", required: true } },
          annotations: { db: { tableName: "post", indexes: [] } },
        },
        {
          name: "Comment",
          fields: { body: { kind: "text", required: true } },
          annotations: { db: { tableName: "comment", indexes: [] } },
        },
      ],
    }
    const astB = {
      models: [
        {
          name: "Comment",
          fields: { body: { kind: "text", required: true } },
          annotations: { db: { tableName: "comment", indexes: [] } },
        },
        {
          name: "Post",
          fields: { title: { kind: "text", required: true } },
          annotations: { db: { tableName: "post", indexes: [] } },
        },
      ],
    }

    // The AST keeps the order `schema/index.ts` was written in, so the generated file does
    // too: alphabetising threw away an order the author chose and the source of truth kept.
    const a = generateClientAugmentation(astA)
    const b = generateClientAugmentation(astB)
    expect(a.indexOf("post:")).toBeLessThan(a.indexOf("comment:"))
    expect(b.indexOf("comment:")).toBeLessThan(b.indexOf("post:"))
    expect(a).not.toEqual(b)
  })

  it("resolves tableName from AST v2 annotations.db.tableName", () => {
    const ast = {
      models: [
        {
          name: "Profile",
          fields: { id: { kind: "uuid", required: true } },
          annotations: { db: { tableName: "profile", indexes: [] } },
        },
      ],
    }
    const out = generateClientAugmentation(ast)
    expect(out).toContain("profile:")
    expect(out).not.toContain("undefined:")
  })

  it("falls back to snake_case model name when tableName is missing", () => {
    const ast = {
      models: [{ name: "Profile", fields: { id: { kind: "uuid", required: true } } }],
    }
    expect(generateClientAugmentation(ast)).toContain("profile:")
  })

  it("marks Insert fields optional when serverGenerated or default is set", () => {
    const ast = {
      models: [
        {
          tableName: "widget",
          fields: {
            id: { kind: "uuid", pgType: "UUID", required: true, primaryKey: true, default: { kind: "genRandomUuid" } },
            name: { kind: "text", pgType: "TEXT", required: true },
            created_at: { kind: "text", pgType: "TEXT", required: true, serverGenerated: true },
          },
        },
      ],
    }
    const out = generateClientAugmentation(ast)
    const insertOnly = out.split("Update:")[0] ?? out
    expect(insertOnly).toContain("id?:")
    expect(insertOnly).toContain("created_at?:")
    expect(insertOnly).toContain("name: string")
    expect(insertOnly).not.toContain("name?:")
  })

  it("types richText fields as the Lexical document they hold", () => {
    const ast = {
      models: [
        {
          tableName: "note",
          fields: {
            id: { kind: "uuid", pgType: "UUID", required: true, primaryKey: true, default: { kind: "genRandomUuid" } },
            body: { kind: "richText", pgType: "JSONB", required: true },
          },
        },
      ],
    }
    const out = generateClientAugmentation(ast)
    expect(out).toContain('import type { SerializedEditorState } from "@supatype/types/lexical"')
    expect(out).toContain("export type RichText = SerializedEditorState")
    expect(out).toContain("body: RichText")
    expect(out).not.toMatch(/body: Record<string, unknown>/)
  })

  it("uses a field's declared tsType instead of collapsing JSONB to an opaque object", () => {
    // `Currency<"USD">` and `Code<"sql">` are stored as JSONB because each carries two values. If
    // the generated row typed them as `Record<string, unknown>`, a caller reading `price.amount`
    // would get no help from the schema that already knows the shape.
    const ast = {
      models: [
        {
          name: "Snippet",
          annotations: { db: { tableName: "snippet", indexes: [] } },
          fields: {
            price: {
              kind: "json",
              pgType: "JSONB",
              required: true,
              tsType: '{ amount: string; code: "USD" }',
            },
            notes: { kind: "json", pgType: "JSONB", required: false },
          },
        },
      ],
    }

    const out = generateClientAugmentation(ast)
    expect(out).toContain('price: { amount: string; code: "USD" }')
    // A field with no declared shape still falls back, and optional fields still admit null.
    expect(out).toContain("notes: Record<string, unknown> | null")
  })
})

describe("exact-value numeric kinds", () => {
  /**
   * A column whose value does not survive an IEEE-754 double must not be typed as one.
   *
   * `decimal` used to emit `number` here while `@supatype/types` declared `Decimal<P, S>` as
   * `string` and the engine emitted `string`, so the ambient client type contradicted both and
   * told a caller a rounded value was exact.
   */
  it("types money, decimal and bigInt so the exact value survives", () => {
    const out = generateClientAugmentation({
      models: [
        {
          name: "Invoice",
          annotations: { db: { tableName: "invoice", indexes: [] } },
          fields: {
            total: { kind: "money", required: true },
            rate: { kind: "decimal", required: true },
            ref: { kind: "bigInt", required: true },
            qty: { kind: "integer", required: true },
          },
        },
      ],
    })

    expect(out).toContain("total: string")
    expect(out).toContain("rate: string")
    expect(out).toContain("ref: bigint")
    // The kinds that genuinely fit a double are untouched.
    expect(out).toContain("qty: number")
  })
})

describe("relation fields", () => {
  const talk = {
    models: [
      {
        name: "Talk",
        annotations: { db: { tableName: "talk", indexes: [] } },
        fields: {
          title: { kind: "text", required: true },
          speaker: {
            kind: "relation",
            cardinality: "belongsTo",
            target: "Speaker",
            annotations: { db: { foreignKey: "speaker_id" } },
          },
          venue: {
            kind: "relation",
            cardinality: "belongsTo",
            target: "Room",
            required: true,
            annotations: { db: { foreignKey: "room_id" } },
          },
          authUser: { kind: "relation", cardinality: "belongsTo", target: "User" },
          slots: { kind: "relation", cardinality: "hasMany", target: "Slot" },
        },
      },
    ],
  }

  /**
   * A `belongsTo` is a foreign key column, not an embedded object.
   *
   * The generator used to group `relation` with geo/vector/image and emit
   * `Record<string, unknown>` under the *declared* name, so the augmentation claimed a column
   * named `speaker` holding an object while Postgres and the engine both had `speaker_id`
   * holding text. Wrong name and wrong type on the same column.
   */
  it("emits the foreign key column, not the declared relation name", () => {
    const out = generateClientAugmentation(talk)
    expect(out).toContain("speaker_id: string | null")
    expect(out).not.toContain("speaker: Record<string, unknown>")
  })

  it("keeps a required relation non-nullable, matching the engine", () => {
    expect(generateClientAugmentation(talk)).toContain("room_id: string\n")
  })

  /** No `foreignKey` annotation, so the column name falls back to the same convention. */
  it("derives the column name when the AST carries no foreignKey", () => {
    expect(generateClientAugmentation(talk)).toContain("auth_user_id: string | null")
  })

  /** The key lives on the other table, so this side has no column to describe. */
  it("omits hasMany, which is not a column on this table", () => {
    const out = generateClientAugmentation(talk)
    expect(out).not.toContain("slots")
  })
})

describe("column shapes that disagreed with the database", () => {
  it("types a localized column as a locale map", () => {
    // `page.title` is jsonb holding {"en": "...", "fr": "..."} and this said `string`, so
    // `page.title.toUpperCase()` compiled and then failed in the browser.
    const row = generateRowType({
      title: { kind: "text", required: true, localized: true },
    })
    expect(row).toContain("title: { [locale: string]: string }")
  })

  it("leaves a non-localized column of the same kind alone", () => {
    // The control: a fix that wrapped every text column would pass the assertion above.
    const row = generateRowType({ slug: { kind: "text", required: true } })
    expect(row).toContain("slug: string")
    expect(row).not.toContain("locale")
  })

  it("types an image as what storage.upload actually produces", () => {
    // Was `Record<string, unknown>`, which is why the examples cast on the good path. Named
    // rather than written out, so this file and `types/database.ts` say it the same way.
    const row = generateRowType({
      headshot: { kind: "image", required: false, bucket: "speaker-headshots" },
    })
    expect(row).toContain("headshot: StorageReference | null")
  })

  it("types a file the same way", () => {
    const row = generateRowType({ attachment: { kind: "file", required: true } })
    expect(row).toContain("attachment: StorageReference")
  })

  it("does not store a url, because a stored one goes stale", () => {
    const row = generateRowType({ headshot: { kind: "image", required: true } })
    expect(row).not.toContain("url")
  })
})

/**
 * What this file has to agree with.
 *
 * `types/database.ts` and `supatype/generated/index.d.ts` describe the same columns of the
 * same tables, and are written by two different generators: the engine's and this one. When
 * they were compared column by column for a real schema, three of them disagreed, and in
 * every case this side was the one that was wrong. Each is pinned below.
 *
 * The comparison itself is not automated here, because it needs an engine binary. What is
 * automated is the property each disagreement came down to.
 */
describe("agreement with the engine's generator", () => {
  const ast = {
    models: [
      {
        name: "Event",
        fields: {
          id: { kind: "uuid", required: true, primaryKey: true },
          title: { kind: "text", required: true },
          slug: { kind: "slug", required: true },
          description: { kind: "richText", required: false },
          cover_image: { kind: "image", required: false },
        },
        annotations: { db: { tableName: "event", indexes: [] } },
      },
    ],
  }

  /**
   * A slug is filled by a trigger the engine emits, so an insert need not supply one. This
   * side demanded it, which asked for a value the database was about to overwrite.
   */
  it("does not demand a slug on insert", () => {
    const out = generateClientAugmentation(ast)
    const insert = out.split("Insert: {")[1]?.split("}")[0] ?? ""
    expect(insert).toContain("slug?:")
    expect(insert).not.toContain("slug: ")
  })

  /**
   * A rich-text column holds a Lexical document. `| string` said it might hold a bare string
   * too, so this file and `types/database.ts` disagreed about the same column.
   */
  it("types rich text as the document it holds, and nothing looser", () => {
    const out = generateClientAugmentation(ast)
    expect(out).toContain("description: RichText | null")
    expect(out).not.toContain("SerializedEditorState | string")
  })

  /** Named aliases, the same ones, so a reader moving between the two files is not
   * comparing spellings. */
  it("names the shared types rather than writing them out", () => {
    const out = generateClientAugmentation(ast)
    expect(out).toContain("export type RichText = SerializedEditorState")
    expect(out).toContain("export type StorageReference = {")
    expect(out).toContain("cover_image: StorageReference | null")
    expect(out).not.toContain("{ bucket: string; path: string }")
  })

  /** Emitted only when the schema uses them. */
  it("declares no alias the schema does not use", () => {
    const plain = generateClientAugmentation({
      models: [
        {
          name: "Note",
          fields: { body: { kind: "text", required: true } },
          annotations: { db: { tableName: "note", indexes: [] } },
        },
      ],
    })
    expect(plain).not.toContain("RichText")
    expect(plain).not.toContain("StorageReference")
  })

  /** The columns sit inside the block that holds them. */
  it("indents each column into its own block", () => {
    const out = generateClientAugmentation(ast)
    expect(out).toContain("        title: string")
    expect(out).not.toMatch(/^ {2}title: string$/m)
  })

  /** In the order the schema declares them, because the AST keeps that order. */
  it("keeps the schema's column order", () => {
    const out = generateClientAugmentation(ast)
    const row = out.split("Row: {")[1]?.split("}")[0] ?? ""
    const order = ["id", "title", "slug", "description", "cover_image"]
    const positions = order.map((column) => row.indexOf(`${column}:`))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})
