/**
 * What a push to a database Supatype did not set up needs before the engine runs.
 *
 * A push to plain Postgres failed inside the engine with `role "anon" does not exist`, and once the
 * roles existed, with `relation "auth.users" does not exist` for a schema relating to users: raw
 * errors naming one gap at a time, with nothing about how to close it (T2-N11). This asks first and
 * lists every gap with the statement or step that closes it.
 */

import pg from "pg"
import { isJsonObject } from "@supatype/shared"
import { apiRoleSql } from "./db-preflight.js"
import { astModels, objectAt } from "./ast-read.js"
import { queryRows, type UnknownRow } from "./db-rows.js"

/** The roles PostgREST switches to per request, which the engine grants to. */
const API_ROLES = ["anon", "authenticated", "service_role"] as const

/** What the database lacks for this push. */
export interface ByoGaps {
  missingRoles: string[]
  /** The schema relates to `SupatypeAuthUser` and `auth.users` does not exist. */
  missingAuthUsers: boolean
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<UnknownRow[]>

/** True when a model relates to Supatype's own users, whose table is `auth.users`. */
export function astRelatesToAuthUsers(ast: unknown): boolean {
  return astModels(ast).some((model) =>
    Object.values(objectAt(model, "fields") ?? {}).some(
      (field) => isJsonObject(field) && field["kind"] === "relation" && field["target"] === "supatype:user",
    ),
  )
}

/** The gaps, asked of the database through `q`. */
export async function findByoGaps(q: QueryFn, ast: unknown): Promise<ByoGaps> {
  const rows = await q("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [[...API_ROLES]])
  const present = new Set(rows.map((row) => String(row["rolname"])))
  const missingRoles = API_ROLES.filter((role) => !present.has(role))
  let missingAuthUsers = false
  if (astRelatesToAuthUsers(ast)) {
    const [found] = await q("SELECT to_regclass('auth.users') IS NOT NULL AS present")
    missingAuthUsers = found?.["present"] !== true
  }
  return { missingRoles, missingAuthUsers }
}

/** What to tell the person, or an empty list when nothing is missing. */
export function byoGapLines(gaps: ByoGaps): string[] {
  const lines: string[] = []
  if (gaps.missingRoles.length > 0) {
    lines.push(
      `Missing role(s): ${gaps.missingRoles.join(", ")}. The API switches to these per request and the push grants to them.`,
      "Create them as a superuser (service_role needs BYPASSRLS):",
      "",
      ...gaps.missingRoles.map((role) => `  ${apiRoleSql(role)}`),
      "",
    )
  }
  if (gaps.missingAuthUsers) {
    lines.push(
      "Missing table auth.users. The schema relates to SupatypeAuthUser, whose table it is.",
      "Supatype's auth server creates it with its migrations the first time it starts against this database:",
      "start the server (supatype/server) with DATABASE_URL pointing here once, then push again.",
      "",
    )
  }
  if (lines.length > 0) {
    lines.push("`supatype db check --connection <url>` lists everything else this database needs.")
  }
  return lines
}

/** The gaps of the database at `databaseUrl` for pushing `ast`, as lines to print. */
export async function byoPreflight(databaseUrl: string, ast: unknown): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return byoGapLines(await findByoGaps((sql, params) => queryRows(client, sql, params), ast))
  } finally {
    await client.end().catch(() => undefined)
  }
}
