/**
 * Does this database meet what Supatype needs of it?
 *
 * Written for the bring-your-own-Postgres case: an external database will not look like
 * `supatype/postgres`, and the failures it produces are mostly indirect. The four API roles are
 * the sharpest example — every `GRANT` the engine emits is guarded with
 * `IF EXISTS (SELECT 1 FROM pg_roles …)`, so a missing role is skipped in silence and the symptom
 * is an API that cannot switch roles at all, days later.
 *
 * So each check states the requirement, what depends on it, and the SQL that fixes it. One module
 * holds both the probe and the remedy on purpose: `--emit` and `--fix` cannot then disagree with
 * what `check` reported.
 *
 * **Severity is about consequence, not tidiness.** `Fail` means the stack will not work. `Degrade`
 * means a named feature is unavailable and everything else is fine. `Warn` means the operator
 * should know something, and nothing is wrong.
 */

import pg from "pg"

export type Severity = "pass" | "warn" | "degrade" | "fail"

export interface CheckResult {
  id: string
  title: string
  severity: Severity
  /** What was found, in the operator's terms. */
  detail: string
  /** What stops working, named. Omitted when nothing does. */
  impact?: string
  /** SQL that resolves it, if SQL can. */
  remedy?: string
  /**
   * True when the remedy cannot run inside a transaction — server settings, chiefly. `--fix`
   * refuses these and reports them rather than half-applying.
   */
  remedyNeedsOperator?: boolean
}

export interface PreflightReport {
  results: CheckResult[]
  /** Highest severity seen, so a caller can pick an exit code without re-deriving it. */
  worst: Severity
}

/** Slot name for the decoding probe. Dropped immediately; never left behind. */
const PROBE_SLOT = "supatype_preflight_probe"

type QueryFn = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>

/**
 * Ask the database to do the one thing realtime needs, then undo it.
 *
 * SQLSTATEs measured against `supatype/postgres` rather than recalled:
 * `55000` wal_level too low, `58P01` the plugin's library is absent, `42501` the role may not use
 * replication slots.
 */
async function probeLogicalDecoding(q: QueryFn): Promise<CheckResult> {
  const base = { id: "logical-decoding", title: "wal2json logical decoding (realtime)" }
  try {
    await q(`SELECT pg_create_logical_replication_slot($1, 'wal2json')`, [PROBE_SLOT])
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const detail =
      code === "58P01"
        ? "the wal2json output plugin is not installed on this server"
        : code === "42501"
          ? "this role may not use replication slots (no REPLICATION attribute)"
          : error instanceof Error
            ? error.message
            : String(error)
    return {
      ...base,
      severity: "degrade",
      detail,
      impact:
        "Realtime subscriptions are unavailable; everything else is unaffected. The service still " +
        "starts, reports this reason on /health/ready, and serves nothing else differently.",
      ...(code === "42501"
        ? { remedy: `ALTER ROLE CURRENT_USER WITH REPLICATION;`, remedyNeedsOperator: true }
        : {
            remedy: [
              "-- wal2json is a server library, not an extension: it must be installed on the host",
              "-- (or offered by your provider) and cannot be added over SQL. Supatype's own image",
              "-- ships it. Set database.external.realtime: false to stop starting the service.",
            ].join("\n"),
            remedyNeedsOperator: true,
          }),
    }
  }

  // Leave nothing behind. A slot that is never read holds WAL forever, which on a database Supatype
  // does not own is the rudest possible failure: the disk fills and nothing says why.
  try {
    await q(`SELECT pg_drop_replication_slot($1)`, [PROBE_SLOT])
  } catch (error) {
    return {
      ...base,
      severity: "warn",
      detail: "the probe slot was created but could not be dropped",
      impact:
        `An unread replication slot named "${PROBE_SLOT}" retains WAL indefinitely and will ` +
        "eventually fill the disk.",
      remedy: `SELECT pg_drop_replication_slot('${PROBE_SLOT}');`,
    }
  }

  return { ...base, severity: "pass", detail: "a wal2json slot can be created and dropped" }
}

const REQUIRED_ROLES = ["anon", "authenticated", "service_role", "authenticator"] as const

/**
 * Stands in for the `authenticator` password when the operator has not supplied one.
 *
 * Fine to print for a human to replace; never acceptable to execute. `--fix` refuses when a remedy
 * still contains it, because the decision was that this credential belongs to the operator —
 * Supatype does not invent one for a database it does not own, and creating a role with a
 * placeholder password would be worse than refusing.
 */
export const PASSWORD_PLACEHOLDER = "<choose-a-password>"

/** True when this remedy would execute the placeholder rather than a real credential. */
export function needsOperatorPassword(remedies: readonly CheckResult[]): boolean {
  return remedies.some((r) => r.remedy?.includes(PASSWORD_PLACEHOLDER) === true)
}

const SEVERITY_ORDER: Record<Severity, number> = { pass: 0, warn: 1, degrade: 2, fail: 3 }

function worstOf(results: CheckResult[]): Severity {
  return results.reduce<Severity>(
    (acc, r) => (SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[acc] ? r.severity : acc),
    "pass",
  )
}

/** Minimum server version. Settled by the owner; the masking rewrite touches planner internals. */
const MIN_MAJOR = 17

export interface PreflightOptions {
  /** Schema Supatype will manage. Matches `schema.pg_schema`. */
  schema: string
  /** Password to give `authenticator` in the remedy, when it has to be created. */
  authenticatorPassword?: string
}

export async function runPreflight(
  client: pg.ClientBase,
  opts: PreflightOptions,
): Promise<PreflightReport> {
  const results: CheckResult[] = []
  const q = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await client.query<T>(sql, params)).rows

  /** For probes that always return exactly one row. */
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> => {
    const rows = await q<T>(sql, params)
    const row = rows[0]
    if (!row) throw new Error(`Preflight probe returned no rows: ${sql}`)
    return row
  }

  // ── Server version ─────────────────────────────────────────────────────────
  const { server_version_num } = await one<{ server_version_num: string }>(
    "SHOW server_version_num",
  )
  const major = Math.floor(Number(server_version_num) / 10000)
  results.push({
    id: "server-version",
    title: `Postgres ${MIN_MAJOR} or later`,
    severity: major >= MIN_MAJOR ? "pass" : "fail",
    detail: `server reports major version ${major}`,
    ...(major < MIN_MAJOR && {
      impact: "Supatype's baseline is PG17; the masking rewrite depends on planner internals that are not stable across majors.",
    }),
  })

  // ── Who are we, and what can we do ─────────────────────────────────────────
  const privs = await one<{
    current_user: string
    is_super: boolean
    can_create_role: boolean
  }>(`SELECT current_user,
             rolsuper      AS is_super,
             rolcreaterole AS can_create_role
        FROM pg_roles WHERE rolname = current_user`)

  results.push({
    id: "connection-identity",
    title: "Connected identity",
    severity: "pass",
    detail:
      `connected as "${privs.current_user}"` +
      (privs.is_super ? " (superuser)" : privs.can_create_role ? " (can create roles)" : " (cannot create roles)"),
  })

  // ── Target schema ──────────────────────────────────────────────────────────
  const schemaRows = await q<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname = $1",
    [opts.schema],
  )
  const schemaExists = schemaRows.length > 0
  const { can_create, database } = await one<{ can_create: boolean; database: string }>(
    `SELECT has_database_privilege(current_database(), 'CREATE') AS can_create,
            current_database() AS database`,
  )
  results.push({
    id: "target-schema",
    title: `Schema "${opts.schema}"`,
    severity: schemaExists || can_create ? "pass" : "fail",
    detail: schemaExists
      ? `exists`
      : can_create
        ? "does not exist, and can be created"
        : "does not exist, and this role cannot create it",
    ...(!schemaExists && can_create && { remedy: `CREATE SCHEMA IF NOT EXISTS ${ident(opts.schema)};` }),
    ...(!schemaExists && !can_create && {
      impact: "The engine needs its own schema for migration history and schema state.",
    }),
  })

  // `CREATE` on the database, which the check above only asked about when the target schema was
  // missing — and `public` always exists, so on a database where the role cannot create schemas that
  // check passed while the stack could not start.
  //
  // Measured on a role with `CONNECT` and `USAGE ON SCHEMA public` but no `CREATE`: storage's
  // bootstrap fails `42501 permission denied for database`, and so does every one of the engine's own
  // schemas. Storage was the least examined service in this plan and this is the whole of what it
  // needs — no extensions, no superuser, no replication, just somewhere to put `storage.buckets` and
  // `storage.objects`.
  results.push({
    id: "create-schemas",
    title: "CREATE on the database",
    severity: can_create ? "pass" : "fail",
    detail: can_create ? "granted" : "not granted to this role",
    ...(!can_create && {
      impact:
        "Four schemas cannot be created: `storage` (buckets and objects), `_platform` (trigger " +
        "functions), `supatype` (Studio's views) and `_supatype` (migration history). Storage exits " +
        "at boot and the engine cannot record a migration.",
      remedy: `GRANT CREATE ON DATABASE ${ident(database)} TO ${ident(privs.current_user)};`,
    }),
  })

  // ── The four API roles ─────────────────────────────────────────────────────
  const roleRows = await q<{ rolname: string; rolinherit: boolean; rolcanlogin: boolean }>(
    `SELECT rolname, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)`,
    [REQUIRED_ROLES as unknown as string[]],
  )
  const present = new Map(roleRows.map((r) => [r.rolname, r]))
  const missing = REQUIRED_ROLES.filter((r) => !present.has(r))

  results.push({
    id: "api-roles",
    title: "API roles (anon, authenticated, service_role, authenticator)",
    severity: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? "all four present"
        : `missing: ${missing.join(", ")}`,
    ...(missing.length > 0 && {
      // The silence is the point: without these, nothing errors, the API just cannot switch roles.
      impact:
        "PostgREST switches to these roles per request. Every GRANT the engine emits is guarded " +
        "with IF EXISTS on the role, so absent roles are skipped silently and the failure surfaces " +
        "later as an API that cannot authenticate." +
        // Found by running --fix as a CREATEROLE-but-not-superuser operator, which is what a
        // managed provider typically gives you: it failed with a bare "permission denied to
        // create role" because BYPASSRLS is superuser-only. Better to say so up front.
        (needsSuperuserForRoles(missing, privs.is_super)
          ? "\n         Note: service_role needs BYPASSRLS, which only a superuser can grant. " +
            `This connection is not a superuser, so --fix cannot create it — have someone with ` +
            `superuser apply the emitted SQL, or create service_role first.`
          : ""),
      remedy: roleRemedy(missing, opts.authenticatorPassword),
      // A remedy that cannot succeed at this privilege level should not be attempted in a
      // transaction that will only roll back.
      ...(needsSuperuserForRoles(missing, privs.is_super) && { remedyNeedsOperator: true }),
    }),
  })

  // `authenticator` must not inherit: it is the containment boundary that stops a JWT naming a
  // privileged role from getting it.
  const authenticator = present.get("authenticator")
  if (authenticator) {
    const ok = !authenticator.rolinherit && authenticator.rolcanlogin
    results.push({
      id: "authenticator-shape",
      title: "authenticator is NOINHERIT and can log in",
      severity: ok ? "pass" : "fail",
      detail: `rolinherit=${authenticator.rolinherit}, rolcanlogin=${authenticator.rolcanlogin}`,
      ...(!ok && {
        impact:
          "NOINHERIT is what confines PostgREST to anon/authenticated/service_role. An INHERIT " +
          "authenticator carries the privileges of every role granted to it.",
        remedy: `ALTER ROLE authenticator NOINHERIT LOGIN;`,
      }),
    })

    const memberships = await q<{ rolname: string }>(
      `SELECT r.rolname FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles g ON g.oid = m.member
        WHERE g.rolname = 'authenticator'`,
    )
    const held = new Set(memberships.map((m) => m.rolname))
    const needed = ["anon", "authenticated", "service_role"].filter((r) => !held.has(r))
    results.push({
      id: "authenticator-memberships",
      title: "authenticator can reach the three API roles",
      severity: needed.length === 0 ? "pass" : "fail",
      detail: needed.length === 0 ? "all three granted" : `not granted: ${needed.join(", ")}`,
      ...(needed.length > 0 && {
        impact: "PostgREST cannot SET ROLE to a role it is not a member of; those requests fail.",
        remedy: needed.map((r) => `GRANT ${r} TO authenticator;`).join("\n"),
      }),
    })
  }

  // ── Extensions ─────────────────────────────────────────────────────────────
  const installed = new Set(
    (await q<{ extname: string }>("SELECT extname FROM pg_extension")).map((r) => r.extname),
  )
  const available = new Set(
    (await q<{ name: string }>("SELECT name FROM pg_available_extensions")).map((r) => r.name),
  )

  results.push(
    extensionCheck("pgcrypto", installed, available, {
      title: "pgcrypto",
      needs: "UUID primary keys — the engine emits gen_random_uuid() defaults.",
      whenMissing: "fail",
    }),
  )
  for (const name of ["vector", "postgis"] as const) {
    results.push(
      extensionCheck(name, installed, available, {
        title: name,
        needs: `only schemas using ${name === "vector" ? "Vector<> fields" : "Geo/GeoPoint fields"}.`,
        whenMissing: "warn",
      }),
    )
  }

  results.push({
    id: "ext-supatype_mask",
    title: "supatype_mask (field-level access rules)",
    severity: installed.has("supatype_mask") ? "pass" : "degrade",
    detail: installed.has("supatype_mask")
      ? "installed"
      : available.has("supatype_mask")
        ? "available but not installed"
        : "not available on this server",
    ...(!installed.has("supatype_mask") && {
      impact:
        "Per-column read/write rules (access.fields) cannot be enforced. A push carrying them " +
        "refuses rather than applying a schema whose restrictions do not exist.",
      ...(available.has("supatype_mask") && { remedy: "CREATE EXTENSION IF NOT EXISTS supatype_mask;" }),
    }),
  })

  // ── Realtime ───────────────────────────────────────────────────────────────
  const { wal_level } = await one<{ wal_level: string }>("SHOW wal_level")
  const walLogical = wal_level === "logical"
  results.push({
    id: "wal-level",
    title: "wal_level = logical (realtime)",
    severity: walLogical ? "pass" : "degrade",
    detail: `wal_level is "${wal_level}"`,
    ...(!walLogical && {
      impact: "Realtime subscriptions are unavailable; everything else is unaffected.",
      remedy:
        "-- Requires a server restart, and on managed Postgres a parameter-group change\n" +
        "-- rather than SQL. Shown for a self-managed server:\n" +
        "ALTER SYSTEM SET wal_level = 'logical';",
      remedyNeedsOperator: true,
    }),
  })

  const slots = await one<{ used: string; max: string }>(
    `SELECT (SELECT count(*) FROM pg_replication_slots)::text AS used,
            current_setting('max_replication_slots') AS max`,
  )
  const slotsFree = Number(slots.max) - Number(slots.used)
  results.push({
    id: "replication-slots",
    title: "A spare replication slot (realtime)",
    severity: slotsFree > 0 ? "pass" : "degrade",
    detail: `${slots.used} of ${slots.max} in use`,
    ...(slotsFree <= 0 && {
      impact: "Realtime cannot create its slot.",
      remedy: "ALTER SYSTEM SET max_replication_slots = 10;",
      remedyNeedsOperator: true,
    }),
  })

  // The definitive realtime check: create the slot realtime would create, then drop it.
  //
  // There is no catalog to consult. `wal2json` is a shared library, not an extension, so it never
  // appears in `pg_available_extensions` — the only way to know whether this database can decode is
  // to ask it to. Cloud SQL does not ship the plugin at all; plenty of managed Postgres will not
  // grant `REPLICATION`. Both produce a stack that looks healthy until the first subscription.
  //
  // Skipped when `wal_level` or the slot budget already rules it out, since the probe would fail for
  // that reason and report it a second time under a less specific heading.
  if (walLogical && slotsFree > 0) {
    results.push(await probeLogicalDecoding(q))
  }

  // ── Existing tables in the target schema ───────────────────────────────────
  if (schemaExists) {
    const tables = await q<{ relname: string }>(
      // Anything not carrying Supatype's ownership marker. Today that is every table, since
      // tables are not stamped yet (E4); once they are, this narrows to genuinely foreign ones
      // without needing to change.
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r'
          AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'supatype:managed%'
        ORDER BY c.relname`,
      [opts.schema],
    )
    if (tables.length > 0) {
      const names = tables.map((t) => t.relname)
      results.push({
        id: "existing-tables",
        title: `Existing tables in "${opts.schema}"`,
        severity: "warn",
        detail:
          `${names.length} table(s) Supatype did not create: ` +
          names.slice(0, 8).join(", ") +
          (names.length > 8 ? `, … and ${names.length - 8} more` : ""),
        impact:
          "These are not described by your schema. Model them, or keep them out of the managed " +
          "schema — a push only manages what it created.",
      })
    }
  }

  return { results, worst: worstOf(results) }
}

function extensionCheck(
  name: string,
  installed: Set<string>,
  available: Set<string>,
  meta: { title: string; needs: string; whenMissing: Severity },
): CheckResult {
  if (installed.has(name)) {
    return { id: `ext-${name}`, title: meta.title, severity: "pass", detail: "installed" };
  }
  if (available.has(name)) {
    return {
      id: `ext-${name}`,
      title: meta.title,
      severity: "warn",
      detail: "available but not installed",
      impact: `Needed for ${meta.needs}`,
      remedy: `CREATE EXTENSION IF NOT EXISTS ${ident(name)};`,
    }
  }
  return {
    id: `ext-${name}`,
    title: meta.title,
    severity: meta.whenMissing,
    detail: "not available on this server",
    impact: `Needed for ${meta.needs}`,
  }
}

/**
 * SQL to create the missing API roles.
 *
 * `authenticator` needs a password because PostgREST logs in as it; the others never do. The
 * password is the operator's to supply — Supatype does not invent a credential for a database it
 * does not own.
 */
function roleRemedy(missing: readonly string[], authenticatorPassword?: string): string {
  const lines: string[] = []
  for (const role of missing) {
    if (role === "authenticator") {
      const pw = authenticatorPassword
        ? `'${authenticatorPassword.replace(/'/g, "''")}'`
        : `'${PASSWORD_PLACEHOLDER}'`
      lines.push(`CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD ${pw};`)
    } else if (role === "service_role") {
      // BYPASSRLS is what makes seeds, migrations and server-side code work.
      lines.push(`CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;`)
    } else {
      lines.push(`CREATE ROLE ${ident(role)} NOLOGIN NOINHERIT;`)
    }
  }
  if (missing.includes("authenticator") || missing.length > 0) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      lines.push(`GRANT ${role} TO authenticator;`)
    }
  }
  return lines.join("\n")
}

/**
 * Whether creating the missing roles needs superuser rather than merely CREATEROLE.
 *
 * `service_role` carries `BYPASSRLS`, and only a superuser may set that attribute. A CREATEROLE
 * operator — which is what managed Postgres typically gives you — gets "permission denied to
 * create role" with no indication that the attribute is the reason.
 */
function needsSuperuserForRoles(missing: readonly string[], isSuperuser: boolean): boolean {
  return missing.includes("service_role") && !isSuperuser
}

/** Quote an identifier for inclusion in emitted SQL. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Everything `--fix` can apply, as one script.
 *
 * Excludes anything needing the operator (server settings), because those cannot be transactional
 * and mostly cannot be done in SQL on managed Postgres at all.
 */
export function transactionalRemedies(report: PreflightReport): CheckResult[] {
  return report.results.filter((r) => r.remedy !== undefined && r.remedyNeedsOperator !== true)
}

export function operatorRemedies(report: PreflightReport): CheckResult[] {
  return report.results.filter((r) => r.remedyNeedsOperator === true)
}

/**
 * Apply the transactional remedies in a **single transaction**.
 *
 * `CREATE ROLE`, `GRANT`, `CREATE SCHEMA` and `CREATE EXTENSION` are all transactional in
 * Postgres, so any failure rolls the whole thing back and the database is exactly as it was. That
 * is the guarantee worth having when the database belongs to someone else.
 *
 * Server settings are the exception and are never included — `ALTER SYSTEM` cannot run in a
 * transaction, and needs a restart besides. Those are reported for the operator to do.
 */
export async function applyRemedies(
  client: pg.ClientBase,
  remedies: readonly CheckResult[],
): Promise<void> {
  if (remedies.length === 0) return
  await client.query("BEGIN")
  try {
    for (const r of remedies) {
      // Comment lines are guidance, not SQL.
      const sql = r.remedy!.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")
      if (sql.trim() === "") continue
      await client.query(sql)
    }
    await client.query("COMMIT")
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw err
  }
}
