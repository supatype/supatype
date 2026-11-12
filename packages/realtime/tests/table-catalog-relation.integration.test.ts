import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import pg from "pg"
import { TableCatalog, relationRefusal } from "../src/table-catalog.js"

/**
 * The catalog lookup a join waits on (0.9.2 release test N-FF5), against a real database.
 *
 * Needs `DATABASE_URL`; any Postgres will do. Skips otherwise.
 */
const databaseUrl = process.env["DATABASE_URL"]

const SETUP = `
  DROP TABLE IF EXISTS public.rt_kind_note CASCADE;
  DROP TABLE IF EXISTS public.rt_kind_late;
  CREATE TABLE public.rt_kind_note (id text PRIMARY KEY);
  CREATE VIEW public.rt_kind_list AS SELECT id FROM public.rt_kind_note;
`

describe.skipIf(!databaseUrl)("TableCatalog.relationKind", () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await pool.query(SETUP)
  })

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS public.rt_kind_note CASCADE; DROP TABLE IF EXISTS public.rt_kind_late")
    await pool.end()
  })

  it("tells a table from a view from nothing at all", async () => {
    const tables = new TableCatalog(pool)
    expect(await tables.relationKind("public", "rt_kind_note")).toBe("r")
    expect(await tables.relationKind("public", "rt_kind_list")).toBe("v")
    expect(await tables.relationKind("public", "rt_kind_notes")).toBeNull()
    expect(await tables.relationKind("no_such_schema", "rt_kind_note")).toBeNull()
  })

  it("asks the database once for a table that exists, however many joins name it", async () => {
    const tables = new TableCatalog(pool)
    const query = vi.spyOn(pool, "query")
    try {
      await Promise.all([1, 2, 3].map(() => tables.relationKind("public", "rt_kind_note")))
      await tables.relationKind("public", "rt_kind_note")
      expect(query).toHaveBeenCalledTimes(1)
    } finally {
      query.mockRestore()
    }
  })

  it("finds a table created after a join for it was refused", async () => {
    const tables = new TableCatalog(pool)
    expect(await tables.relationKind("public", "rt_kind_late")).toBeNull()
    await pool.query("CREATE TABLE public.rt_kind_late (id int)")
    expect(await tables.relationKind("public", "rt_kind_late")).toBe("r")
  })

  it("refuses by kind, naming the relation", () => {
    expect(relationRefusal("public", "notes", null)).toContain("public.notes does not exist")
    expect(relationRefusal("public", "list", "v")).toContain("public.list is not a table")
    expect(relationRefusal("public", "note", "r")).toBeNull()
    expect(relationRefusal("public", "parted", "p")).toBeNull()
  })
})
