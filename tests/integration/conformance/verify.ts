/**
 * What every field kind must do on a real database.
 *
 * Six assertions per kind, chosen because each one corresponds to a defect that shipped:
 *
 *   1. the column Postgres created                  (nothing caught `money` being NUMERIC)
 *   2. the AST publishes that same type             (it said TEXT, and a consumer believed it)
 *   3. the generated TypeScript matches the column  (required relations, enum defaults)
 *   4. a value survives a round trip through REST
 *   5. a second push proposes nothing               (the draft-policy phantom diff)
 *   6. the field can be dropped again               (the draft-view dependency)
 *
 * Run against a live stack. Every one of those was invisible to the unit suites, which were green
 * throughout.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compositeKinds, deferredKinds, testableKinds, unreachableKinds } from "./kinds.js"
import { fieldName } from "./generate-schema.js"
import { createClient } from "@supatype/client"
import { pathToFileURL } from "node:url"

/**
 * Load the project's generated client, which is what registers its exact-value columns.
 *
 * An application does this with a static import, `import { createClient } from "./supatype/client"`.
 * This file is compiled from the repository and runs against a project scaffolded into a temporary
 * directory, so the path is only known at runtime, but the effect is identical: importing the
 * generated module is what tells the client which columns must not be read as doubles.
 *
 * Skipping it is the case worth exercising too. Without it nothing is registered, and a bigInt
 * column is reported as unreadable rather than returned rounded.
 */
async function loadGeneratedClient(): Promise<boolean> {
  const generated = join(PROJECT, "supatype", "generated", "client.ts")
  if (!existsSync(generated)) return false

  // Imported from a copy inside the repository rather than in place. The scaffolded project is
  // created with `--no-install`, so it has no `node_modules`, and a bare `@supatype/client` cannot
  // resolve from a temporary directory. The file's contents are what is under test, not where it
  // sits: a real project has the package installed and imports it where it lies.
  const local = join(import.meta.dirname, ".generated-client.ts")
  writeFileSync(local, readFileSync(generated, "utf8"), "utf8")
  try {
    await import(pathToFileURL(local).href)
  } finally {
    rmSync(local, { force: true })
  }
  return true
}

/**
 * The kinds a JSON parser destroys, which therefore cannot be graded on parsed output.
 *
 * `bigInt`, `decimal` and `money` are read back through the client instead, because the client is
 * the only reader that repairs them. Reading with `fetch` alone tested PostgREST, never us.
 */
const EXACT_KINDS = new Set(["bigInt", "bigSerial", "decimal", "money"])

const PROJECT = process.env["CONFORMANCE_PROJECT"] ?? process.cwd()
const BASE_URL = process.env["SUPATYPE_URL"] ?? "http://127.0.0.1:18473"
const ANON_KEY = process.env["ANON_KEY"] ?? ""
const CLI = process.env["SUPATYPE_CLI"] ?? "supatype"

const failures: string[] = []
let checks = 0

function check(ok: boolean, what: string, detail?: string): void {
  checks += 1
  if (ok) {
    console.log(`  ok   ${what}`)
    return
  }
  console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`)
  failures.push(what)
}

function cli(...args: string[]): string {
  return execFileSync("node", [CLI, ...args], {
    cwd: PROJECT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

interface ColumnRow {
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: string
}

async function main(): Promise<void> {
  const kinds = testableKinds()
  console.log(`\n==> ${kinds.length} declarable kinds, on a real database`)

  // ── 1. the column Postgres created ──────────────────────────────────────────
  //
  // Read from the catalogue dump the runner takes through `docker exec`, rather than by connecting:
  // nothing guarantees Postgres is published to the host, and a harness that needs it to be fails
  // for a reason that has nothing to do with the thing under test.
  const rows = JSON.parse(
    readFileSync(process.env["CONFORMANCE_COLUMNS"]!, "utf8"),
  ) as ColumnRow[]
  const byName = new Map(rows.map((r) => [r.column_name, r]))

  console.log("\n==> 1. the column Postgres created")
  for (const [kind, spec] of kinds) {
    const col = byName.get(columnOf(kind))
    if (!col) {
      check(false, `${kind}: column exists`, `no column ${columnOf(kind)}`)
      continue
    }
    const typeOk =
      col.data_type === spec.pgDataType &&
      (spec.pgUdtName === undefined || col.udt_name === spec.pgUdtName)
    check(typeOk, `${kind}: column is ${spec.pgDataType}`, `got ${col.data_type}/${col.udt_name}`)
  }

  // ── 2. the AST publishes that type ──────────────────────────────────────────
  //
  // The contract consumers generate code from. `money` said TEXT for a NUMERIC column, so a parser
  // written from it rejected every value the column returns.
  console.log("\n==> 2. the AST publishes the type the column has")
  const ast = JSON.parse(
    readFileSync(join(PROJECT, ".supatype", "schema.ast.json"), "utf8"),
  ) as { models: { name: string; fields: Record<string, { annotations?: { db?: { pgType?: string } } }> }[] }
  const probe = ast.models.find((m) => m.name === "probeAll")
  for (const [kind] of kinds) {
    // A relation carries no pgType of its own: the column is a foreign key the engine derives, and
    // its type comes from the referenced primary key. Nothing to compare.
    if (kind === "relation") continue
    const declared = probe?.fields[fieldName(kind)]?.annotations?.db?.pgType ?? ""
    const col = byName.get(columnOf(kind))
    if (!col || declared === "") {
      check(false, `${kind}: AST publishes a pgType`, `declared=${declared || "(none)"}`)
      continue
    }
    // An array's catalogue type is `ARRAY` with the element in `udt_name` (`_text`), and the AST
    // says `ARRAY` too. Comparing the element against the word ARRAY would always fail.
    const actual = col.data_type === "ARRAY" ? "ARRAY" : col.data_type
    // Compared by family rather than string: the AST says NUMERIC(19,4) where the catalogue says
    // `numeric`, and both are right. A mismatch that matters is TEXT against numeric.
    check(
      family(declared) === family(actual),
      `${kind}: AST pgType agrees with the column`,
      `ast=${declared} column=${actual}`,
    )
  }

  // ── 3. the generated TypeScript matches ─────────────────────────────────────
  console.log("\n==> 3. the generated TypeScript matches the column")
  const generated = readFileSync(
    join(PROJECT, "supatype", "generated", "database.ts"),
    "utf8",
  )
  const rowBlock = block(generated, "probe_all", "Row")
  for (const [kind] of kinds) {
    const name = columnOf(kind)
    const col = byName.get(name)
    if (!col) continue
    const line = rowBlock.split("\n").find((l) => l.trim().startsWith(`${name}:`))
    if (line === undefined) {
      check(false, `${kind}: appears in the generated Row type`)
      continue
    }
    // Every probe column is optional in the schema, so every one must be nullable in the Row type.
    // The inverse of the relation bug, where a NOT NULL column was typed `| null`.
    check(
      (col.is_nullable === "YES") === line.includes("| null"),
      `${kind}: Row nullability matches the column`,
      `column nullable=${col.is_nullable}, type=${line.trim()}`,
    )
  }

  // ── 4. a value round trips ──────────────────────────────────────────────────
  console.log("\n==> 4. a value survives a round trip")
  const writable = kinds.filter(([, s]) => s.sample !== null)
  const body: Record<string, unknown> = {}
  for (const [kind, spec] of writable) body[columnOf(kind)] = spec.sample
  const created = await fetch(`${BASE_URL}/rest/v1/probe_all`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  })
  if (!created.ok) {
    check(false, "a row with every kind is accepted", `HTTP ${created.status}: ${await created.text()}`)
  } else {
    const wire = await created.text()
    check(true, "a row with every kind is accepted")

    // Read the body twice, because the two halves fail differently and both matter.
    //
    // The wire is checked as TEXT, not as parsed JSON. `created.json()` runs the very `JSON.parse`
    // that destroys an exact-value column, so asserting on its output can only ever tell you that
    // JavaScript rounds, which is not in question. Checking the raw bytes says whether the SERVER
    // sent the right digits.
    for (const [kind, spec] of writable) {
      if (typeof spec.sample !== "string") continue
      const column = columnOf(kind)
      const sent = spec.sample
      const onWire =
        wire.includes(`"${column}":${sent}`) ||
        wire.includes(`"${column}":"${sent}"`) ||
        wire.includes(`"${column}":${sent.replace(/0+$/, "")}`)
      if (EXACT_KINDS.has(kind)) {
        check(onWire, `${kind}: the server sends every digit`, `looked for ${sent} in ${wire.slice(0, 200)}`)
      }
    }

    // Then through the real client, which is where the repair lives. Reading with `fetch` alone
    // tested PostgREST and never the thing we ship.
    const parsed = JSON.parse(wire) as Record<string, unknown>[]
    const [row] = parsed
    for (const [kind, spec] of writable) {
      // Non-exact kinds are graded on the parsed value, which is correct for them: a `text` or
      // `boolean` column loses nothing to `JSON.parse`.
      if (EXACT_KINDS.has(kind)) continue
      const got = row?.[columnOf(kind)]
      const ok = spec.expect ? spec.expect(got) : JSON.stringify(got) === JSON.stringify(spec.sample)
      check(ok, `${kind}: value round trips`, `sent ${JSON.stringify(spec.sample)}, got ${JSON.stringify(got)}`)
    }

    // The exact-value kinds are graded through the client, because that is the only reader that
    // repairs them. Grading them on `JSON.parse` output would assert that JavaScript rounds.
    const registered = await loadGeneratedClient()
    check(registered, "the generated client exists and registers the project's columns")
    const client = createClient({ url: BASE_URL, anonKey: ANON_KEY })
    const read = await client.from("probe_all").select().limit(1)
    if (read.error !== null) {
      check(false, "the client can read the probe row", read.error.message)
    } else {
      const clientRow = (read.data ?? [])[0] as Record<string, unknown> | undefined
      check(clientRow !== undefined, "the client can read the probe row")
      for (const [kind, spec] of writable) {
        if (!EXACT_KINDS.has(kind)) continue
        const got = clientRow?.[columnOf(kind)]
        const ok = spec.expect ? spec.expect(got) : false
        check(
          ok,
          `${kind}: the client returns it exactly`,
          `sent ${JSON.stringify(spec.sample)}, got ${String(got)} (${typeof got})`,
        )
      }
    }
  }

  // ── 5. a second push proposes nothing ───────────────────────────────────────
  //
  // One line, and it is the assertion the draft-policy phantom diff needed: that bug reported the
  // same two operations on every diff, applied them, and reported them again.
  console.log("\n==> 5. pushing twice is a no-op")
  const second = cli("diff")
  check(second.includes("No changes"), "a diff with no schema change reports nothing", second.trim().split("\n").slice(-2).join(" "))

  // ── 6. and a kind can be taken away again ───────────────────────────────────
  //
  // Asserted by the harness script, which rewrites the schema without the probe model and pushes.
  // Left there rather than here because it needs to edit files and re-run the CLI.

  // ── coverage, stated rather than implied ────────────────────────────────────
  console.log("\n==> coverage")
  const deferred = deferredKinds()
  const unreachable = unreachableKinds()
  const composites = compositeKinds()
  console.log(`  ${kinds.length} covered, ${deferred.length} deferred, ${unreachable.length} unreachable, ${composites.length} composite`)
  for (const [kind, spec] of deferred) console.log(`  deferred    ${kind}: ${spec.needs}`)
  for (const [kind, spec] of unreachable) console.log(`  unreachable ${kind}: ${spec.reason.slice(0, 96)}`)

  console.log("")
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.length} of ${checks} checks`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log(`PASSED: ${checks} checks across ${kinds.length} field kinds`)
}

/**
 * The column a kind's field becomes.
 *
 * The engine preserves the field name verbatim, so `probeXml` is a column called `probeXml` and not
 * `probe_xml`. A relation is the exception: `target: RelatedTo<...>` becomes the foreign key
 * `target_id`, which is the only place a name is derived rather than kept.
 */
function columnOf(kind: string): string {
  return kind === "relation" ? "target_id" : fieldName(kind)
}

/** The type family, so `NUMERIC(19,4)` and `numeric` compare equal but `TEXT` and `numeric` do not. */
function family(pgType: string): string {
  return pgType.toLowerCase().replace(/\(.*\)$/, "").replace(/\s+/g, " ").trim()
}

/** One `Row` / `Insert` / `Update` block of one table in the generated types. */
function block(src: string, table: string, mode: "Row" | "Insert" | "Update"): string {
  const start = src.indexOf(`      ${table}: {`)
  if (start === -1) return ""
  const rest = src.slice(start)
  const open = rest.indexOf(`${mode}: {`)
  if (open === -1) return ""
  const close = rest.indexOf("}", open)
  return rest.slice(open, close)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
