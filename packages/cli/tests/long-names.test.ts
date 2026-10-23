import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"
import { generateHooksModule } from "../src/hooks-generator.js"
import { generateProjectClient } from "../src/client-generator.js"
import { manifestHooks, manifestValidators } from "../src/model-hooks.js"
import { manifestCache } from "../src/model-cache.js"
import { seedApiConfigCache } from "../src/api-config-cache.js"
import { planColumnDeclaration } from "../src/adopt-columns.js"

/**
 * Postgres keeps 63 bytes of a name and the engine names every table, junction and key column as
 * Postgres keeps it. Everything the CLI generates or sends keyed by a table must use that name, or
 * it names a table the database does not have.
 */

const LONG_TABLE = "conference_attendee_registration_dietary_preferences_and_requirements"
const KEPT_TABLE = LONG_TABLE.slice(0, 63)
const LEFT = "conference_attendee_registration_dietary_notes"
const RIGHT = "conference_session_speaker_availability_window"
const MULTIBYTE = "é".repeat(40)

const hook = { beforeInsert: { function: "check-registration" } }

/** A type member keyed by `name`, quoted or bare, as the generators write it. */
function keyed(name: string): RegExp {
  return new RegExp(`^\\s*"?${name}"?: \\{`, "m")
}

function model(name: string, tableName: string, extra: Record<string, unknown> = {}) {
  return { name, fields: { id: { kind: "uuid", primaryKey: true } }, annotations: { db: { tableName } }, ...extra }
}

const longModel = model("Registration", LONG_TABLE, {
  fields: { id: { kind: "uuid", primaryKey: true }, fee: { kind: "bigint" } },
  options: { versions: true },
  annotations: { db: { tableName: LONG_TABLE }, platform: { hooks: hook, validate: hook, cache: { enabled: true } } },
})
const ast = { models: [longModel, model("Accent", MULTIBYTE)] }

describe("tables named past 63 bytes", () => {
  it("keys the client augmentation by the name Postgres keeps", () => {
    const out = generateClientAugmentation(ast)
    expect(out).toMatch(keyed(KEPT_TABLE))
    expect(out).not.toContain(LONG_TABLE)
    expect(out).toMatch(keyed("é".repeat(31)))
  })

  it("keys the hooks module by the name Postgres keeps", () => {
    const out = generateHooksModule(ast) ?? ""
    expect(out).toContain(`"${KEPT_TABLE}": {`)
    expect(out).not.toContain(LONG_TABLE)
  })

  it("registers exact kinds and drafts under the name Postgres keeps", () => {
    const out = generateProjectClient(ast)
    expect(out).toContain(`"${KEPT_TABLE}": {`)
    expect(out).not.toContain(LONG_TABLE)
  })

  it("keys the hooks and validators manifests by the name Postgres keeps", () => {
    expect(Object.keys(manifestHooks(ast))).toEqual([KEPT_TABLE])
    expect(Object.keys(manifestValidators(ast))).toEqual([KEPT_TABLE])
  })

  it("keys the cache declarations, and the local allowlist seeded from them, by the kept name", () => {
    expect(Object.keys(manifestCache(ast))).toEqual([KEPT_TABLE])
    const dir = tempDir()
    mkdirSync(join(dir, ".supatype"))
    writeFileSync(join(dir, ".supatype", "api-config.json"), JSON.stringify({ rest: {} }))
    expect(seedApiConfigCache(dir, ast)?.seeded).toEqual([KEPT_TABLE])
    expect(readFileSync(join(dir, ".supatype", "api-config.json"), "utf8")).not.toContain(LONG_TABLE)
  })
})

describe("many-to-many past 63 bytes", () => {
  const many = { kind: "relation", cardinality: "manyToMany", target: "Window" }

  it("names the derived junction from the two full names, then cuts it", () => {
    const out = generateClientAugmentation({
      models: [model("Note", LEFT, { fields: { windows: many } }), model("Window", RIGHT)],
    })
    expect(out).toMatch(keyed(`${LEFT}_${RIGHT}`.slice(0, 63)))
    expect(out).not.toContain(`${LEFT}_${RIGHT}`)
  })

  it("cuts a declared `through` and a key column named from a long model", () => {
    const longName = "ConferenceAttendeeRegistrationDietaryPreferencesAndRequirements"
    const through = `${LONG_TABLE}_links`
    const out = generateClientAugmentation({
      models: [model(longName, "regs", { fields: { tags: { ...many, target: "Tag", through } } }), model("Tag", "tags")],
    })
    expect(out).toMatch(keyed(through.slice(0, 63)))
    expect(out).toContain(`"${`${LONG_TABLE}_id`.slice(0, 63)}"`)
    expect(out).not.toContain(`${LONG_TABLE}_id"`)
  })

  it("cuts a belongsTo key column named from a long field", () => {
    const field = "conferenceAttendeeRegistrationDietaryPreferencesAndRequirements"
    const belongs = { kind: "relation", cardinality: "belongsTo", target: "Tag" }
    const out = generateClientAugmentation({ models: [model("Note", "notes", { fields: { [field]: belongs } }), model("Tag", "tags")] })
    expect(out).toContain(`"${`${LONG_TABLE}_id`.slice(0, 63)}"`)
    expect(out).not.toContain(`${LONG_TABLE}_id"`)
  })
})

describe("adopting a column of a table named past 63 bytes", () => {
  it("finds the model whose table Postgres keeps under the database's name", () => {
    const dir = tempDir()
    const entry = join(dir, "schema", "index.ts")
    mkdirSync(join(dir, "schema"))
    writeFileSync(
      entry,
      `import type { Model, Public, UUID } from "@supatype/types"\n` +
        `export type Registration = Model<{ id: UUID; title: string }, { tableName: "${LONG_TABLE}"; access: { read: Public } }>\n`,
    )
    const live = { name: "rank", dataType: "int4", udtName: "int4", nullable: false, default: "0" }
    const planned = planColumnDeclaration({ entryPath: entry, cwd: dir, table: KEPT_TABLE, column: "rank", live, identityColumns: true })
    expect(planned).toMatchObject({ status: "planned", model: "Registration" })
    const declared = planColumnDeclaration({ entryPath: entry, cwd: dir, table: KEPT_TABLE, column: "title", live: undefined, identityColumns: true })
    expect(declared).toMatchObject({ status: "declared", model: "Registration" })
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-long-names-"))
  dirs.push(dir)
  return dir
}
