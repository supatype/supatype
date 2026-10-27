import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `supatype dev` asked "Create an admin user now?" on every start of a project with no admin, and
 * waited for the answer. The first setup asks once; a "no" is kept for the project, so later starts
 * do not ask or wait again. `supatype admin create-user` is there when they want one.
 */

const confirmMock = vi.hoisted(() => vi.fn<(message: string) => Promise<boolean>>())
const interactive = vi.hoisted(() => ({ value: true }))

vi.mock("../src/ui/confirm.js", () => ({ confirm: confirmMock }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: () => interactive.value }))
vi.mock("../src/ui/messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/messages.js")>()),
  info: () => undefined,
}))

/** A database with an auth schema and no admin. */
async function query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
  if (sql.includes("table_name = 'users'")) return { rows: [{ exists: true }] }
  if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }] }
  return { rows: [{ exists: false }] }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-admin-once-"))
  writeFileSync(join(dir, ".env"), "JWT_SECRET=x\n")
  confirmMock.mockReset()
  interactive.value = true
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("the first-admin prompt", () => {
  it("is not asked again once declined for the project", async () => {
    const { ensureFirstAdminWithQuery } = await import("../src/commands/admin.js")
    confirmMock.mockResolvedValue(false)
    await ensureFirstAdminWithQuery(query, { cwd: dir })
    await ensureFirstAdminWithQuery(query, { cwd: dir })
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it("is not asked, and does not wait, when the run is not interactive", async () => {
    const { ensureFirstAdminWithQuery } = await import("../src/commands/admin.js")
    interactive.value = false
    await ensureFirstAdminWithQuery(query, { cwd: dir })
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it("is asked again in another project", async () => {
    const { ensureFirstAdminWithQuery } = await import("../src/commands/admin.js")
    confirmMock.mockResolvedValue(false)
    await ensureFirstAdminWithQuery(query, { cwd: dir })
    const other = mkdtempSync(join(tmpdir(), "supatype-admin-once-other-"))
    try {
      await ensureFirstAdminWithQuery(query, { cwd: other })
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    expect(confirmMock).toHaveBeenCalledTimes(2)
  })
})
