import { describe, expect, it } from "vitest"
import { restoreSystemRelationTargets } from "../src/restore-system-relation-targets.js"

const LONG_TABLE = "conference_attendee_registration_dietary_preferences_and_requirements"
const KEPT_TABLE = LONG_TABLE.slice(0, 63)

function model(name: string, tableName: string, extra: Record<string, unknown> = {}) {
  return { name, fields: { id: { kind: "uuid", primaryKey: true } }, annotations: { db: { tableName } }, ...extra }
}

describe("restoring system relation targets", () => {
  const owner = { kind: "relation", cardinality: "belongsTo", target: "supatype:user" }
  const field = { name: "owner", widget: "relation", options: { target: "users" } }

  it("finds a multi-word model by its table, not its lowercased name", () => {
    const admin = { models: [{ tableName: "blog_post", fields: [{ ...field, options: { target: "users" } }] }] }
    restoreSystemRelationTargets(admin, { models: [model("BlogPost", "blog_post", { fields: { owner } })] })
    expect(admin.models[0]?.fields[0]?.options.target).toBe("supatype:user")
  })

  it("finds a model whose table is named past 63 bytes by the name Postgres keeps", () => {
    const admin = { models: [{ tableName: KEPT_TABLE, fields: [{ ...field, options: { target: "users" } }] }] }
    restoreSystemRelationTargets(admin, { models: [model("Registration", LONG_TABLE, { fields: { owner } })] })
    expect(admin.models[0]?.fields[0]?.options.target).toBe("supatype:user")
  })
})
