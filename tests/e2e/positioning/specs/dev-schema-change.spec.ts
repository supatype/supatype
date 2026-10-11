import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { PROJECT_DIR, sql } from "../../masking/lib/stack.js"

/**
 * What the site promises about changing a schema under `supatype dev`, in a project made by
 * `supatype init` (so with no `output` section in its config):
 *
 * - "Change a field once. Nothing else to update." The generated types follow the schema (V-N2).
 * - "Rename a field and the build fails instead of production." A rename never silently empties
 *   the column (V-N1): the data survives as a rename, or dev refuses the change.
 *
 * Ported from the owner's check in Pre-Launch-Verification-Evidence ("Owner check of the
 * positioning claims"). The runner leaves `supatype dev` watching the project, with three rows in
 * `member`.
 */
const SCHEMA = join(PROJECT_DIR, "schema", "index.ts")
const TYPES = join(PROJECT_DIR, "types", "database.ts")
const DEV_LOG = process.env["POSITIONING_DEV_LOG"] ?? join(PROJECT_DIR, "dev.log")
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc")

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const hasColumn = (column: string): boolean =>
  sql(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'member' and column_name = '${column}'`) === "1"

async function until(what: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (what()) return true
    await sleep(1000)
  }
  return what()
}

function editSchema(from: string, to: string): void {
  const before = readFileSync(SCHEMA, "utf8")
  const after = before.replace(from, to)
  if (after === before) throw new Error(`schema edit found no "${from}"`)
  writeFileSync(SCHEMA, after)
}

/** Typechecks one app file against the project's generated types; true when it compiles. */
function compiles(file: string, source: string): { ok: boolean; output: string } {
  writeFileSync(join(PROJECT_DIR, file), source)
  const run = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "--module", "esnext",
    "--moduleResolution", "bundler", "--target", "es2022", join(PROJECT_DIR, file)], { encoding: "utf8" })
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` }
}

const memberRow = 'import type { Database } from "./types/database"\ntype Member = Database["public"]["Tables"]["member"]["Row"]\n'

test.describe.serial("supatype dev in a project made by init", () => {
  test("the project starts from a typed member with a name", () => {
    expect(existsSync(TYPES), `${TYPES} written by supatype generate`).toBe(true)
    const app = compiles("check-name.ts", `${memberRow}export const name = (m: Member): string => m.name\n`)
    expect(app.ok, app.output).toBe(true)
  })

  test("a new field reaches the generated types (V-N2)", async () => {
    editSchema("  name: string\n", "  name: string\n  nickname: Optional<string>\n")
    expect(await until(() => hasColumn("nickname"), 120_000), "dev applied the new field").toBe(true)
    await until(() => readFileSync(TYPES, "utf8").includes("nickname"), 30_000)
    const app = compiles("check-nickname.ts", `${memberRow}export const nick = (m: Member): string | null => m.nickname\n`)
    expect(app.ok, app.output).toBe(true)
  })

  test("a rename never empties the column (V-N1)", async () => {
    const logBefore = readFileSync(DEV_LOG, "utf8").length
    editSchema("  name: string\n", "  title: string\n")
    const reacted = (): boolean => hasColumn("title") || /destructive|refus|--force/i.test(readFileSync(DEV_LOG, "utf8").slice(logBefore))
    expect(await until(reacted, 120_000), "dev reacted to the rename").toBe(true)
    const kept = hasColumn("name")
      ? sql("select count(*) from public.member where name is not null and name <> ''")
      : sql("select count(*) from public.member where title is not null and title <> ''")
    expect(kept, "rows still holding their name").toBe("3")
  })
})
