import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { QueryResult } from "pg"

/**
 * M3: after creating an admin the CLI said "Log in at /admin". Studio is served at `/studio/`,
 * and `/admin` answers nothing, so the one instruction it gave led nowhere. It now names Studio,
 * with the stack's own address when it knows it.
 */

const said = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  info: (message: string) => {
    said.lines.push(message)
  },
}))

const { ensureFirstAdminWithQuery, studioLoginHint } = await import("../src/commands/admin.js")

function rows(list: Record<string, unknown>[]): QueryResult {
  return { rows: list, rowCount: list.length, command: "SELECT", oid: 0, fields: [] }
}

/** A database with auth ready, no admin yet, and an insert that succeeds. */
async function answer(sql: string): Promise<QueryResult> {
  if (sql.includes("information_schema.tables")) return rows([{ exists: true }])
  if (sql.includes("to_regclass")) return rows([{ exists: false }])
  if (sql.includes("information_schema.columns")) return rows([{ column_name: "email_confirmed_at" }])
  if (sql.includes("INSERT INTO auth.users")) return rows([{ id: "11111111-2222-3333-4444-555555555555" }])
  return rows([])
}

let cwd = ""

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-admin-studio-"))
  said.lines.length = 0
})

afterEach(() => rmSync(cwd, { recursive: true, force: true }))

async function createFirstAdmin(studioUrl?: string): Promise<string> {
  await ensureFirstAdminWithQuery(answer, {
    cwd,
    email: "admin@example.com",
    password: "password123",
    ...(studioUrl !== undefined && { studioUrl }),
  })
  return said.lines.join("\n")
}

describe("where the CLI says to log in after creating an admin", () => {
  it("names the stack's Studio URL when it knows it", async () => {
    const out = await createFirstAdmin("http://localhost:18880/studio/")
    expect(out).toContain("Log in to Studio at http://localhost:18880/studio/")
    expect(out).not.toContain("/admin")
  })

  it("points at /studio/ on the API URL when the stack's address is not known", async () => {
    const out = await createFirstAdmin()
    expect(out).toContain("/studio/")
    expect(out).not.toContain("/admin")
  })

  it("says the same thing after `admin create-user`", () => {
    expect(studioLoginHint("http://localhost:18880/studio/")).toBe(
      "Log in to Studio at http://localhost:18880/studio/",
    )
    expect(studioLoginHint(undefined)).not.toContain("/admin")
  })
})
