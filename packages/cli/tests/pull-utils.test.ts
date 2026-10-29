import { describe, it, expect } from "vitest"
import {
  databaseStateToSchemaScaffold,
  introspectColumnToColumnInfo,
  pgTypeToField,
  pgTypeToModelField,
  toCamelCase,
  type ColumnInfo,
} from "../src/pull-utils.js"

function col(overrides: Partial<ColumnInfo> & { pgType: string }): ColumnInfo {
  return {
    name: "col",
    nullable: true,
    isPrimary: false,
    isUnique: false,
    hasDefault: false,
    ...overrides,
  }
}

describe("pgTypeToField()", () => {
  it.each([
    ["uuid", "field.uuid("],
    ["text", "field.text("],
    ["varchar(255)", "field.text("],
    ["character varying", "field.text("],
    ["int4", "field.integer("],
    ["integer", "field.integer("],
    ["int8", "field.bigInt("],
    ["bigint", "field.bigInt("],
    ["int2", "field.smallInt("],
    ["smallint", "field.smallInt("],
    ["float8", "field.float("],
    ["double precision", "field.float("],
    ["real", "field.float("],
    ["numeric", "field.decimal("],
    ["decimal", "field.decimal("],
    ["bool", "field.boolean("],
    ["boolean", "field.boolean("],
    ["date", "field.date("],
    ["timestamp", "field.timestamp("],
    ["timestamptz", "field.datetime("],
    ["timestamp with time zone", "field.datetime("],
    ["json", "field.json("],
    ["jsonb", "field.json("],
    ["inet", "field.ip("],
    ["cidr", "field.cidr("],
    ["macaddr", "field.macaddr("],
    ["bytea", "field.bytea("],
    ["money", "field.money("],
    ["xml", "field.xml("],
    ["interval", "field.interval("],
    ["tsvector", "field.tsvector("],
    ["tsquery", "field.tsquery("],
  ])("maps %s → %s call", (pgType, expectedPrefix) => {
    const result = pgTypeToField(col({ pgType }))
    expect(result).toContain(expectedPrefix)
  })

  it("unknown types fall back to field.text with a TODO comment", () => {
    const result = pgTypeToField(col({ pgType: "some_custom_type" }))
    expect(result).toContain("field.text(")
    expect(result).toContain("TODO")
    expect(result).toContain("some_custom_type")
  })

  it("nullable column sets required: false", () => {
    const result = pgTypeToField(col({ pgType: "text", nullable: true }))
    expect(result).toContain('"required":false')
  })

  it("non-nullable column sets required: true", () => {
    const result = pgTypeToField(col({ pgType: "text", nullable: false }))
    expect(result).toContain('"required":true')
  })

  it("primary key column sets primaryKey: true", () => {
    const result = pgTypeToField(
      col({ pgType: "uuid", isPrimary: true, nullable: false }),
    )
    expect(result).toContain('"primaryKey":true')
  })

  it("unique (non-PK) column sets unique: true", () => {
    const result = pgTypeToField(
      col({ pgType: "text", isUnique: true, isPrimary: false }),
    )
    expect(result).toContain('"unique":true')
  })

  it("primary key column does not also set unique (redundant)", () => {
    const result = pgTypeToField(
      col({ pgType: "uuid", isPrimary: true, isUnique: true }),
    )
    expect(result).not.toContain('"unique"')
  })

  it("jsonb column includes jsonb: true spread", () => {
    const result = pgTypeToField(col({ pgType: "jsonb" }))
    expect(result).toContain("jsonb: true")
  })

  it("plain json column does not include jsonb spread", () => {
    const result = pgTypeToField(col({ pgType: "json" }))
    expect(result).not.toContain("jsonb")
  })
})

describe("introspectColumnToColumnInfo()", () => {
  it("maps engine column → pgType and flags", () => {
    const out = introspectColumnToColumnInfo({
      name: "id",
      dataType: "uuid",
      udtName: "uuid",
      nullable: false,
      default: "gen_random_uuid()",
    })
    expect(out).toEqual({
      name: "id",
      pgType: "uuid",
      nullable: false,
      isPrimary: true,
      isUnique: false,
      hasDefault: true,
    })
  })

  it("treats empty default as no default", () => {
    const out = introspectColumnToColumnInfo({
      name: "x",
      dataType: "text",
      udtName: "text",
      nullable: true,
      default: "",
    })
    expect(out.hasDefault).toBe(false)
  })
})

describe("toCamelCase()", () => {
  it.each([
    ["user", "User"],
    ["blog_post", "BlogPost"],
    ["order_line_item", "OrderLineItem"],
    ["saas_tenant", "SaasTenant"],
    ["alreadyCamel", "AlreadyCamel"],
    ["a", "A"],
    ["api_key", "ApiKey"],
  ])("converts %s → %s", (input, expected) => {
    expect(toCamelCase(input)).toBe(expected)
  })
})

describe("identity and generated columns in the scaffold", () => {
  const field = (col: Parameters<typeof introspectColumnToColumnInfo>[0], identityColumns = true) =>
    pgTypeToModelField(introspectColumnToColumnInfo(col, { identityColumns }))

  it("declares an identity column as one", () => {
    const base = { dataType: "integer", nullable: false, isIdentity: true }
    expect(field({ ...base, name: "id", udtName: "int4", identityGeneration: "ALWAYS" })).toBe("id: Identity<number>")
    expect(field({ ...base, name: "n", udtName: "int8", identityGeneration: "BY DEFAULT" })).toBe(
      'n: Identity<bigint, "by-default">',
    )
    expect(field({ ...base, name: "s", udtName: "int2", identityGeneration: "ALWAYS" })).toBe(
      's: SmallInt<{ identity: "always" }>',
    )
  })

  it("declares a generated column with its expression", () => {
    expect(
      field({
        name: "title_lower",
        dataType: "text",
        udtName: "text",
        nullable: true,
        isGenerated: true,
        generationExpression: "lower(title)",
      }),
    ).toBe('title_lower: Optional<Generated<string, "lower(title)">>')
  })

  it("leaves a plain column as it was", () => {
    expect(field({ name: "n", dataType: "integer", udtName: "int4", nullable: false })).toBe("n: Int")
  })

  it("declares a serial as AutoIncrement", () => {
    const serial = { dataType: "integer", nullable: false, default: "nextval('t_id_seq'::regclass)" }
    expect(field({ ...serial, name: "id", udtName: "int4" })).toBe("id: AutoIncrement<number>")
    expect(field({ ...serial, name: "n", udtName: "int8" })).toBe("n: AutoIncrement<bigint>")
  })

  it("drafts plain fields, saying why, for an engine without identity_columns", () => {
    const identity = { name: "id", dataType: "integer", udtName: "int4", nullable: false, isIdentity: true }
    expect(field({ ...identity, identityGeneration: "ALWAYS" }, false)).toBe(
      "id: Int // TODO: an identity column; this engine does not support identity and generated columns: update it, or declare it by hand",
    )
    const serial = { name: "n", dataType: "integer", udtName: "int4", nullable: false, default: "nextval('s'::regclass)" }
    expect(field(serial, false)).toBe("n: Int")
  })
})

/**
 * `supatype pull` drafted every uuid `id` as SupatypeAuthUserId, which declares the row's key to be
 * an auth user's id, so a pulled `orders` table was modelled as one row per user. And a table whose
 * name the model name does not map back to (`HTTPLog` for a table `http_log` maps to `h_t_t_p_log`)
 * was pushed back under the derived name, as a new, empty table.
 */
describe("databaseStateToSchemaScaffold()", () => {
  const uuidId = { name: "id", dataType: "uuid", udtName: "uuid", nullable: false }
  const scaffold = (table: string): string =>
    databaseStateToSchemaScaffold({ tables: [{ name: table, columns: [uuidId] }] })

  it("drafts a uuid id as UUID, not an auth user's id", () => {
    const out = scaffold("orders")
    expect(out).toMatch(/^ {2}id: UUID$/m)
    expect(out).not.toContain("id: SupatypeAuthUserId")
  })

  it("names the table when the model name would derive a different one", () => {
    expect(scaffold("HTTPLog")).toContain('  tableName: "HTTPLog",')
    expect(scaffold("Orders")).toContain('  tableName: "Orders",')
  })

  it("leaves tableName out when the model name derives the same table", () => {
    expect(scaffold("blog_posts")).toContain("export type BlogPosts = Model<{")
    expect(scaffold("blog_posts")).not.toContain("tableName")
  })
})

/**
 * #19: a uuid column with a foreign key to `auth.users(id)` is a user's id, and the draft says so
 * with SupatypeAuthUserId and the key's delete rule. The engine reports the referenced schema from
 * 0.7.0 on; an older engine names only the table, and `users` in `auth` cannot be told from any
 * other `users`, so the draft stays a plain UUID rather than guess.
 */
describe("databaseStateToSchemaScaffold() and auth.users foreign keys", () => {
  const userId = { name: "user_id", dataType: "uuid", udtName: "uuid", nullable: false }
  const editorId = { name: "editor_id", dataType: "uuid", udtName: "uuid", nullable: true }
  const authKey = (column: string, onDelete: string, extra: Record<string, unknown> = {}) => ({
    table: "posts",
    name: `posts_${column}_fkey`,
    constraintType: "foreignKey",
    columns: [column],
    foreignSchema: "auth",
    foreignTable: "users",
    foreignColumns: ["id"],
    onDelete,
    ...extra,
  })
  const draft = (constraints: Array<Record<string, unknown>>): string =>
    databaseStateToSchemaScaffold({
      tables: [{ name: "posts", columns: [userId, editorId] }],
      constraints: constraints.map((c) => ({ table: "posts", name: "c", constraintType: "foreignKey", columns: [], ...c })),
    })

  it("drafts a user id with the key's delete rule", () => {
    const out = draft([authKey("user_id", "CASCADE"), authKey("editor_id", "SET NULL")])
    expect(out).toContain('  user_id: SupatypeAuthUserId<{ onDelete: "cascade" }>')
    expect(out).toContain('  editor_id: Optional<SupatypeAuthUserId<{ onDelete: "setNull" }>>')
    expect(draft([authKey("user_id", "RESTRICT")])).toContain('  user_id: SupatypeAuthUserId<{ onDelete: "restrict" }>')
  })

  it("says a key with no delete rule the type can declare would be dropped", () => {
    const out = draft([authKey("user_id", "NO ACTION")])
    expect(out).toMatch(/^ {2}user_id: SupatypeAuthUserId \/\/ TODO: .*ON DELETE NO ACTION.*no foreign key/m)
  })

  it("keeps a plain UUID for an engine that does not report the schema", () => {
    const { foreignSchema: _omitted, ...old } = authKey("user_id", "CASCADE")
    const out = draft([old])
    expect(out).not.toContain("SupatypeAuthUserId<")
    expect(out).toMatch(/^ {2}user_id: UUID$/m)
  })

  it("keeps a plain UUID for a key to another schema, another column, or more than one column", () => {
    for (const other of [
      authKey("user_id", "CASCADE", { foreignSchema: "public" }),
      authKey("user_id", "CASCADE", { foreignColumns: ["email"] }),
      authKey("user_id", "CASCADE", { columns: ["user_id", "editor_id"], foreignColumns: ["id", "id"] }),
    ]) {
      expect(draft([other])).not.toContain("SupatypeAuthUserId<")
    }
  })
})
